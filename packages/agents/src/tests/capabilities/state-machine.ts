import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import { LifecycleCapability } from "../../lifecycle/capability";
import type { LifecycleJobContext } from "../../lifecycle/job-queue";
import {
  StateMachine,
  defineGate,
  defineMachine,
  settleStreamOnMachineCommit,
  type MachineDefinition,
  type MachineJson
} from "../../state-machine";
import { createMachineCommitParticipant } from "../../state-machine/commit";
import { Streams } from "../../streams";

type PipelineState =
  | { phase: "first"; label: string }
  | { phase: "second"; label: string }
  | { phase: "third"; label: string };

type CommitState =
  | { phase: "write"; value: string }
  | { phase: "done"; value: string };

type WaitEvent = { type: "message"; key: string; value: string };
type WaitState = {
  phase: "wait";
  key: string;
  timeoutAt: number;
};

type GateState =
  | { phase: "open"; timeoutMs: number }
  | { phase: "waiting"; gateId: string; expiresAt: number };

type HarnessDefinitionName =
  | "pipeline"
  | "waiter"
  | "gracefulCancel"
  | "revisitGate"
  | "replayGate"
  | "permission"
  | "uncommittedEffect"
  | "multiRun"
  | "mixedRun"
  | "runEffect"
  | "effect"
  | "participant"
  | "streamSettlement"
  | "streamSettlementFailure"
  | "participantFailure";

const Permission = defineGate<{ tool: string }, { approved: boolean }>(
  "permission"
);
const OtherPermission = defineGate<{ tool: string }, { approved: boolean }>(
  "other-permission"
);

type EffectState =
  | {
      phase: "plan";
      value: string;
      recovery: "safe" | "never" | "reconcile";
      externalId?: string;
    }
  | {
      phase: "execute";
      effect: {
        id: string;
        kind: string;
        recovery: "safe" | "never" | "reconcile";
      };
    };

type HarnessSnapshot =
  | {
      status: "running" | "waiting" | "paused";
      revision: number;
      state: MachineJson;
      wait?: { type: string; key?: string; timeoutAt?: number };
      gates?: Array<{
        gateId: string;
        kind: string;
        state: string;
        expiresAt: number;
      }>;
      effects?: Array<{ effectId: string; kind: string; status: string }>;
      result?: never;
      error?: never;
    }
  | {
      status: "completed";
      revision: number;
      result?: MachineJson;
      state?: never;
      error?: never;
      wait?: never;
      gates?: never;
      effects?: never;
    }
  | {
      status: "failed" | "cancelled";
      revision: number;
      error: { name: string; message: string };
      state?: never;
      result?: never;
      wait?: never;
      gates?: never;
      effects?: never;
    };

class SyncJobProbe extends LifecycleCapability {
  constructor() {
    super("sync-job-probe");
  }

  async stage(value: string, rollback = false): Promise<void> {
    this.lifecycle.storage.transactionSync(() => {
      this.lifecycle.storage.sql.exec(
        "INSERT INTO sync_job_probe_state (value) VALUES (?)",
        value
      );
      this.lifecycle.jobs.pushSync({
        id: `probe:${value}`,
        fn: "deliver",
        time: Date.now(),
        payload: { value }
      });
      if (rollback) throw new Error("rollback requested");
    });
    await this.lifecycle.jobs.rearm();
  }

  onJob(context: LifecycleJobContext): void {
    const payload = context.job.payload as { value: string };
    this.lifecycle.storage.sql.exec(
      "INSERT INTO sync_job_probe_deliveries (value) VALUES (?)",
      payload.value
    );
  }
}

const pipeline = defineMachine<PipelineState, string, { label: string }>({
  version: 1,
  initial: (input) => ({ phase: "first", label: input.label }),
  phases: {
    first: (state, context) =>
      context.transition({ phase: "second", label: state.label }),
    second: (state, context) =>
      context.transition({ phase: "third", label: state.label }),
    third: (state, context) => context.complete(`done:${state.label}`)
  }
} satisfies MachineDefinition<PipelineState, string, { label: string }>);

export class StateMachineHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly #streams = new Streams();
  readonly #effectRuns: string[] = [];
  readonly #effectReconciles: string[] = [];
  readonly #effectRuntimes = {
    conflict: {
      execute: async (
        input: import("../../state-machine").MachineJson,
        invocation: import("../../state-machine").MachineEffectInvocation
      ) => {
        const runId = invocation.idempotencyKey.split(":", 1)[0]!;
        this.ctx.storage.sql.exec(
          `UPDATE cf_agents_state_machine_runs
           SET revision = revision + 1 WHERE run_id = ?`,
          runId
        );
        const value = (input as { value: string }).value;
        return `conflict:${value}`;
      }
    },
    flaky: {
      execute: async (input: import("../../state-machine").MachineJson) => {
        const { key, failures } = input as { key: string; failures: number };
        this.ctx.storage.sql.exec(
          `INSERT INTO state_machine_effect_attempts (key, attempts)
           VALUES (?, 1)
           ON CONFLICT (key) DO UPDATE SET attempts = attempts + 1`,
          key
        );
        const row = this.ctx.storage.sql
          .exec<{ attempts: number }>(
            "SELECT attempts FROM state_machine_effect_attempts WHERE key = ?",
            key
          )
          .one();
        if (row.attempts <= failures) {
          throw new Error(`flaky attempt ${row.attempts} failed`);
        }
        return `flaky:ok:${row.attempts}`;
      }
    },
    ignoring: {
      execute: async () => new Promise<never>(() => {})
    },
    late: {
      execute: async () => {
        await scheduler.wait(75);
        return "late-output";
      }
    },
    reconcileBlocking: {
      execute: async () => "unused",
      reconcile: async () => new Promise<never>(() => {})
    },
    blocking: {
      execute: async (
        _input: import("../../state-machine").MachineJson,
        invocation: import("../../state-machine").MachineEffectInvocation
      ) =>
        new Promise<never>((_resolve, reject) => {
          const fail = () => reject(invocation.signal.reason);
          if (invocation.signal.aborted) return fail();
          invocation.signal.addEventListener("abort", fail, { once: true });
        })
    },
    echo: {
      execute: async (input: import("../../state-machine").MachineJson) => {
        const value = (input as { value: string }).value;
        this.#effectRuns.push(value);
        return `effect:${value}`;
      },
      reconcile: async (externalId: string) => {
        this.#effectReconciles.push(externalId);
        return externalId.startsWith("done:")
          ? ({
              status: "completed" as const,
              output: `reconciled:${externalId.slice(5)}`
            } as const)
          : ({ status: "running" as const } as const);
      }
    }
  };
  readonly #definitions = {
    pipeline,
    waiter: defineMachine<
      WaitState,
      string,
      { key: string; timeoutMs: number },
      WaitEvent
    >({
      version: 1,
      initial: (input) => ({
        phase: "wait",
        key: input.key,
        timeoutAt: Date.now() + input.timeoutMs
      }),
      phases: {
        wait: (state, context) => {
          const queued = context.events.take({
            type: "message",
            key: state.key
          });
          if (queued) return context.complete(queued.event.value);
          if (context.wake.kind === "timeout") {
            return context.complete("timed-out");
          }
          return context.wait(state, {
            type: "message",
            key: state.key,
            timeoutAt: state.timeoutAt
          });
        }
      }
    }),
    gracefulCancel: defineMachine<WaitState, string, { key: string }>({
      version: 1,
      initial: (input) => ({
        phase: "wait",
        key: input.key,
        timeoutAt: Date.now() + 60_000
      }),
      phases: {
        wait: (state, context) =>
          context.wait(state, {
            type: "message",
            key: state.key,
            timeoutAt: state.timeoutAt
          })
      },
      onCancel: (_state, context) => context.complete("cancel-handled")
    }),
    revisitGate: defineMachine<
      { phase: "run"; pass: number; expiresAt: number },
      string,
      { timeoutMs: number }
    >({
      version: 1,
      initial: (input) => ({
        phase: "run",
        pass: 0,
        expiresAt: Date.now() + input.timeoutMs
      }),
      phases: {
        run: (state, context) => {
          const gate = context.gates.create(
            Permission,
            { tool: `pass-${state.pass}` },
            { expiresAt: state.expiresAt }
          );
          return state.pass === 0
            ? context.transition({ ...state, pass: 1 })
            : context.complete(gate.id);
        }
      }
    }),
    replayGate: defineMachine<
      { phase: "run"; expiresAt: number },
      string,
      { timeoutMs: number },
      WaitEvent
    >({
      version: 1,
      initial: (input) => ({
        phase: "run",
        expiresAt: Date.now() + input.timeoutMs
      }),
      phases: {
        run: (state, context) => {
          const gate = context.gates.create(
            Permission,
            { tool: "replay" },
            { expiresAt: state.expiresAt }
          );
          const event = context.events.take({ type: "message", key: "replay" });
          if (event) return context.complete(gate.id);
          return context.wait(state, { type: "message", key: "replay" });
        }
      }
    }),
    permission: defineMachine<GateState, string, { timeoutMs: number }>({
      version: 1,
      initial: (input) => ({ phase: "open", timeoutMs: input.timeoutMs }),
      phases: {
        open: (state, context) => {
          const expiresAt = Date.now() + state.timeoutMs;
          const gate = context.gates.create(
            Permission,
            { tool: "exec" },
            {
              metadata: { tool: "exec" },
              expiresAt
            }
          );
          return context.transition({
            phase: "waiting",
            gateId: gate.id,
            expiresAt
          });
        },
        waiting: (state, context) => {
          const decision = context.gates.take({
            id: state.gateId,
            kind: Permission.name
          });
          if (decision) {
            if (decision.status !== "answered") {
              return context.complete(decision.status);
            }
            const answer = decision.answer as { approved: boolean };
            return context.complete(answer.approved ? "approved" : "denied");
          }
          if (context.wake.kind === "timeout") {
            return context.complete("expired");
          }
          return context.wait(state, {
            type: "state-machine:gate-answer",
            key: state.gateId,
            timeoutAt: state.expiresAt
          });
        }
      }
    }),
    uncommittedEffect: defineMachine<{ phase: "run" }, string, undefined>({
      version: 1,
      initial: () => ({ phase: "run" }),
      phases: {
        run: async (_state, context) => {
          const effect = context.effects.plan<{ value: string }, string>(
            "echo",
            { value: "uncommitted" },
            { recovery: "safe" }
          );
          const outcome = await context.effects.execute(effect);
          return context.complete(outcome.status);
        }
      }
    }),
    multiRun: defineMachine<{ phase: "run" }, string, undefined>({
      version: 1,
      initial: () => ({ phase: "run" }),
      phases: {
        run: async (_state, context) => {
          const first = await context.effects.run<{ value: string }, string>(
            "echo",
            { value: "first" },
            { recovery: "safe" }
          );
          const second = await context.effects.run<{ value: string }, string>(
            "echo",
            { value: "second" },
            { recovery: "safe" }
          );
          return context.complete(`${first.status}:${second.status}`);
        }
      }
    }),
    mixedRun: defineMachine<
      { phase: "run"; expiresAt: number },
      string,
      undefined
    >({
      version: 1,
      initial: () => ({ phase: "run", expiresAt: Date.now() + 60_000 }),
      phases: {
        run: async (state, context) => {
          context.gates.create(
            Permission,
            { tool: "mixed" },
            { expiresAt: state.expiresAt }
          );
          const outcome = await context.effects.run<{ value: string }, string>(
            "echo",
            { value: "mixed" },
            { recovery: "safe" }
          );
          return context.complete(outcome.status);
        }
      }
    }),
    runEffect: defineMachine<
      {
        phase: "run";
        value: string;
        kind: string;
        recovery: "safe" | "never" | "reconcile";
        timeoutMs?: number;
        retries?: {
          limit?: number;
          delay?: number;
          backoff?: "constant" | "linear" | "exponential";
        };
      },
      string,
      {
        value: string;
        kind?: string;
        recovery?: "safe" | "never" | "reconcile";
        timeoutMs?: number;
        retries?: {
          limit?: number;
          delay?: number;
          backoff?: "constant" | "linear" | "exponential";
        };
      }
    >({
      version: 1,
      initial: (input) => ({
        phase: "run",
        value: input.value,
        kind: input.kind ?? "echo",
        recovery: input.recovery ?? "safe",
        ...(input.timeoutMs === undefined
          ? {}
          : { timeoutMs: input.timeoutMs }),
        ...(input.retries === undefined ? {} : { retries: input.retries })
      }),
      phases: {
        run: async (state, context) => {
          context.events.take({ type: "effect-retry", key: context.runId });
          const input: MachineJson =
            state.kind === "flaky"
              ? {
                  key: state.value,
                  failures: Number(state.value.split(":")[1])
                }
              : { value: state.value };
          const outcome = await context.effects.run<typeof input, string>(
            state.kind,
            input,
            {
              recovery: state.recovery,
              ...(state.timeoutMs === undefined
                ? {}
                : { timeoutMs: state.timeoutMs }),
              ...(state.retries === undefined ? {} : { retries: state.retries })
            }
          );
          if (outcome.status === "completed") {
            return context.complete(
              `${outcome.output}|attempt=${outcome.attempt}`
            );
          }
          if (outcome.status === "failed") {
            return context.complete(
              `failed:${outcome.error.message}|attempt=${outcome.attempt}`
            );
          }
          if (outcome.status === "retrying") {
            return context.wait(state, {
              type: "effect-retry",
              key: context.runId,
              timeoutAt: outcome.retryAt
            });
          }
          return context.complete(
            `${outcome.status}|attempt=${outcome.attempt}`
          );
        }
      }
    }),
    effect: defineMachine<
      EffectState,
      string,
      {
        value: string;
        recovery: "safe" | "never" | "reconcile";
        externalId?: string;
      }
    >({
      version: 1,
      initial: (input) => ({
        phase: "plan",
        value: input.value,
        recovery: input.recovery,
        ...(input.externalId ? { externalId: input.externalId } : {})
      }),
      phases: {
        plan: (state, context) => {
          const effect = context.effects.plan<{ value: string }, string>(
            state.value === "block" ? "blocking" : "echo",
            { value: state.value },
            {
              recovery: state.recovery,
              ...(state.externalId ? { externalId: state.externalId } : {})
            }
          );
          return context.transition({ phase: "execute", effect });
        },
        execute: async (state, context) => {
          const outcome = await context.effects.execute<string>(state.effect);
          if (outcome.status === "completed") {
            return context.complete(outcome.output);
          }
          if (outcome.status === "failed") {
            return context.fail(new Error(outcome.error.message));
          }
          if (outcome.status === "interrupted") {
            return context.complete("interrupted");
          }
          return context.wait(state, {
            type: "effect-ready",
            key: state.effect.id,
            timeoutAt: Date.now() + 1_000
          });
        }
      }
    }),
    participant: defineMachine<CommitState, string, { value: string }>({
      version: 1,
      initial: (input) => ({ phase: "write", value: input.value }),
      phases: {
        write: (state, context) =>
          context.transition(
            { phase: "done", value: state.value },
            {
              commit: [
                createMachineCommitParticipant(() => {
                  this.ctx.storage.sql.exec(
                    "INSERT INTO state_machine_commit_probe (value) VALUES (?)",
                    state.value
                  );
                })
              ]
            }
          ),
        done: (state, context) => context.complete(state.value)
      }
    }),
    streamSettlement: defineMachine<
      { phase: "close"; streamId: string },
      string,
      { streamId: string }
    >({
      version: 1,
      initial: (input) => ({ phase: "close", streamId: input.streamId }),
      phases: {
        close: (state, context) =>
          context.complete(state.streamId, {
            commit: [settleStreamOnMachineCommit(this.#streams, state.streamId)]
          })
      }
    }),
    streamSettlementFailure: defineMachine<
      { phase: "close"; streamId: string },
      string,
      { streamId: string }
    >({
      version: 1,
      initial: (input) => ({ phase: "close", streamId: input.streamId }),
      phases: {
        close: (state, context) =>
          context.complete(state.streamId, {
            commit: [
              settleStreamOnMachineCommit(this.#streams, state.streamId),
              createMachineCommitParticipant(() => {
                throw new Error("later participant failed");
              })
            ]
          })
      }
    }),
    participantFailure: defineMachine<CommitState, string, { value: string }>({
      version: 1,
      initial: (input) => ({ phase: "write", value: input.value }),
      phases: {
        write: (state, context) =>
          context.transition(
            { phase: "done", value: state.value },
            {
              commit: [
                createMachineCommitParticipant(() => {
                  this.ctx.storage.sql.exec(
                    "INSERT INTO state_machine_commit_probe (value) VALUES (?)",
                    state.value
                  );
                  throw new Error("participant failed");
                })
              ]
            }
          ),
        done: (state, context) => context.complete(state.value)
      }
    })
  };

  readonly #jobProbe = new SyncJobProbe();
  readonly #stateMachine = new StateMachine({
    definitions: this.#definitions,
    effects: this.#effectRuntimes
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.#jobProbe)
    .use(this.#streams)
    .use(this.#stateMachine);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS state_machine_commit_probe (value TEXT NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS state_machine_effect_attempts (
        key TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL
      )`
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sync_job_probe_state (value TEXT NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sync_job_probe_deliveries (value TEXT NOT NULL)"
    );
  }

  start(label: string, runId?: string) {
    return this.#stateMachine.run("pipeline", { label }, { runId });
  }

  async stageProbeJob(value: string, rollback = false) {
    try {
      await this.#jobProbe.stage(value, rollback);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  probeState(): { state: string[]; deliveries: string[] } {
    const values = (table: string) =>
      this.ctx.storage.sql
        .exec<{ value: string }>(`SELECT value FROM ${table} ORDER BY rowid`)
        .toArray()
        .map((row) => row.value);
    return {
      state: values("sync_job_probe_state"),
      deliveries: values("sync_job_probe_deliveries")
    };
  }

  startParticipant(value: string, fail = false) {
    return fail
      ? this.#stateMachine.run("participantFailure", { value })
      : this.#stateMachine.run("participant", { value });
  }

  async startStreamSettlement(streamId: string, fail = false) {
    await this.#streams.open(streamId);
    return fail
      ? this.#stateMachine.run("streamSettlementFailure", { streamId })
      : this.#stateMachine.run("streamSettlement", { streamId });
  }

  async streamState(streamId: string): Promise<string | null> {
    return (await this.#streams.status(streamId))?.state ?? null;
  }

  startWaiter(key: string, timeoutMs = 60_000, runId?: string) {
    return this.#stateMachine.run("waiter", { key, timeoutMs }, { runId });
  }

  sendRetryWake(runId: string, eventId: string) {
    return this.#stateMachine.notify(
      runId,
      { type: "effect-retry", key: runId },
      { eventId }
    );
  }

  sendMessage(runId: string, key: string, value: string, eventId: string) {
    return this.#stateMachine.notify(
      runId,
      { type: "message", key, value },
      { eventId }
    );
  }

  async sendMessageError(
    runId: string,
    key: string,
    value: string,
    eventId: string
  ): Promise<string | null> {
    try {
      await this.sendMessage(runId, key, value, eventId);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  startRevisitGate(timeoutMs = 60_000) {
    return this.#stateMachine.run("revisitGate", { timeoutMs });
  }

  startReplayGate(timeoutMs = 60_000) {
    return this.#stateMachine.run("replayGate", { timeoutMs });
  }

  gateRowsFor(runId: string) {
    return this.ctx.storage.sql
      .exec<{ gate_id: string }>(
        `SELECT gate_id FROM cf_agents_state_machine_gates
         WHERE run_id = ? ORDER BY gate_id`,
        runId
      )
      .toArray();
  }

  startPermission(timeoutMs = 60_000) {
    return this.#stateMachine.run("permission", { timeoutMs });
  }

  startGracefulCancel(key: string) {
    return this.#stateMachine.run("gracefulCancel", { key });
  }

  answerPermission(gateId: string, approved: boolean, eventId: string) {
    return this.#stateMachine.gates.notify(
      gateId,
      Permission,
      { approved },
      { eventId }
    );
  }

  answerWrongPermissionKind(gateId: string, eventId: string) {
    return this.#stateMachine.gates.notify(
      gateId,
      OtherPermission,
      { approved: true },
      { eventId }
    );
  }

  withdrawPermission(gateId: string) {
    return this.#stateMachine.gates.withdraw(gateId);
  }

  startEffect(
    value: string,
    recovery: "safe" | "never" | "reconcile",
    externalId?: string
  ) {
    return this.#stateMachine.run("effect", {
      value,
      recovery,
      ...(externalId ? { externalId } : {})
    });
  }

  startMultiRun() {
    return this.#stateMachine.run("multiRun", undefined);
  }

  startMixedRun() {
    return this.#stateMachine.run("mixedRun", undefined);
  }

  startRunEffect(options: {
    value: string;
    kind?: string;
    recovery?: "safe" | "never" | "reconcile";
    timeoutMs?: number;
    retries?: {
      limit?: number;
      delay?: number;
      backoff?: "constant" | "linear" | "exponential";
    };
  }) {
    return this.#stateMachine.run("runEffect", options);
  }

  async uncommittedEffectError(): Promise<string> {
    const receipt = await this.#stateMachine.run(
      "uncommittedEffect",
      undefined
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      const run = await this.#stateMachine.get(receipt.runId);
      if (run?.status === "failed") return run.error.message;
      await scheduler.wait(10);
    }
    return "timed out";
  }

  effectRowsFor(runId: string) {
    return this.ctx.storage.sql
      .exec<{
        effect_id: string;
        revision: number;
        status: string;
        attempt: number;
        retry_at: number | null;
      }>(
        `SELECT effect_id, revision, status, attempt, retry_at
         FROM cf_agents_state_machine_effects
         WHERE run_id = ? ORDER BY created_at, effect_id`,
        runId
      )
      .toArray();
  }

  async seedReconcileTimeout(timeoutMs: number): Promise<string> {
    await this.#stateMachine.get("seed-reconcile-schema");
    const runId = `seed_reconcile_${crypto.randomUUID()}`;
    const effectId = `effect_${crypto.randomUUID()}`;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO cf_agents_state_machine_runs
          (run_id, definition, definition_version, status, phase,
           checkpoint_json, revision, builder_revision, control_json, job_id,
           wait_kind, wait_type, wait_key, next_at, cancel_requested,
           cancel_reason, result_json, error_name, error_message, persist,
           idempotency_key, created_at, updated_at, settled_at)
         VALUES (?, 'effect', 1, 'paused', 'execute', ?, 1, 1,
                 '{"status":"running"}', ?, NULL, NULL, NULL, NULL, 0,
                 NULL, NULL, NULL, NULL, 1, NULL, ?, ?, NULL)`,
        runId,
        JSON.stringify({
          phase: "execute",
          effect: {
            id: effectId,
            kind: "reconcileBlocking",
            recovery: "reconcile",
            timeoutMs
          }
        }),
        `state-machine:${runId}`,
        now,
        now
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO cf_agents_state_machine_effects
          (run_id, effect_id, revision, kind, recovery, status, input_json,
           external_id, result_json, error_name, error_message, attempt,
           retry_at, options_json, created_at, settled_at)
         VALUES (?, ?, 1, 'reconcileBlocking', 'reconcile', 'running', '{}',
                 'external', NULL, NULL, NULL, 1, NULL, ?, ?, NULL)`,
        runId,
        effectId,
        JSON.stringify({ timeoutMs }),
        now
      );
    });
    await this.#stateMachine.resume(runId);
    return runId;
  }

  async seedRunEffectRecovery(
    status: "running" | "completed",
    recovery: "safe" | "never"
  ): Promise<string> {
    await this.#stateMachine.get("seed-run-schema");
    const runId = `seed_run_${crypto.randomUUID()}`;
    const effectId = `${runId}#effect_0_0`;
    const value = `${status}-${recovery}`;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO cf_agents_state_machine_runs
          (run_id, definition, definition_version, status, phase,
           checkpoint_json, revision, builder_revision, control_json, job_id,
           wait_kind, wait_type, wait_key, next_at, cancel_requested,
           cancel_reason, result_json, error_name, error_message, persist,
           idempotency_key, created_at, updated_at, settled_at)
         VALUES (?, 'runEffect', 1, 'paused', 'run', ?, 0, 0,
                 '{"status":"running"}', ?, NULL, NULL, NULL, NULL, 0,
                 NULL, NULL, NULL, NULL, 1, NULL, ?, ?, NULL)`,
        runId,
        JSON.stringify({
          phase: "run",
          value,
          kind: "echo",
          recovery
        }),
        `state-machine:${runId}`,
        now,
        now
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO cf_agents_state_machine_effects
          (run_id, effect_id, revision, kind, recovery, status, input_json,
           external_id, result_json, error_name, error_message, attempt,
           retry_at, created_at, settled_at)
         VALUES (?, ?, 0, 'echo', ?, ?, ?, NULL, ?, NULL, NULL, 1,
                 NULL, ?, ?)`,
        runId,
        effectId,
        recovery,
        status,
        JSON.stringify({ value }),
        status === "completed" ? JSON.stringify(`effect:${value}`) : null,
        now,
        status === "completed" ? now : null
      );
    });
    await this.#stateMachine.resume(runId);
    return runId;
  }

  effectAttempts(key: string): number {
    return (
      this.ctx.storage.sql
        .exec<{ attempts: number }>(
          "SELECT attempts FROM state_machine_effect_attempts WHERE key = ?",
          key
        )
        .toArray()[0]?.attempts ?? 0
    );
  }

  listRuns(
    options?: Omit<
      import("../../state-machine").MachineListOptions,
      "definition"
    > & { definition?: HarnessDefinitionName }
  ) {
    return this.#stateMachine.list(options);
  }

  async listRunsQueryPlan(): Promise<string[]> {
    await this.#stateMachine.get("initialize-list-schema");
    return this.ctx.storage.sql
      .exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT * FROM cf_agents_state_machine_runs
         WHERE definition = ? AND status IN ('running', 'waiting')
         ORDER BY created_at DESC, run_id DESC LIMIT 1`,
        "waiter"
      )
      .toArray()
      .map((row) => row.detail);
  }

  async listRunsError(
    options?: Omit<
      import("../../state-machine").MachineListOptions,
      "definition"
    > & { definition?: HarnessDefinitionName }
  ): Promise<string | null> {
    try {
      await this.#stateMachine.list(options);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  effectActivity() {
    return {
      runs: [...this.#effectRuns],
      reconciles: [...this.#effectReconciles]
    };
  }

  async seedEffectRecovery(
    value: string,
    recovery: "safe" | "never" | "reconcile",
    externalId?: string
  ): Promise<string> {
    await this.#stateMachine.get("seed-schema");
    const runId = `seed_${crypto.randomUUID()}`;
    const effectId = `effect_${crypto.randomUUID()}`;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO cf_agents_state_machine_runs
          (run_id, definition, definition_version, status, phase,
           checkpoint_json, revision, control_json, job_id, wait_kind,
           wait_type, wait_key, next_at, cancel_requested, cancel_reason,
           result_json, error_name, error_message, persist, idempotency_key,
           created_at, updated_at, settled_at)
         VALUES (?, 'effect', 1, 'paused', 'execute', ?, 1,
                 '{"status":"running"}', ?, NULL, NULL, NULL, NULL, 0,
                 NULL, NULL, NULL, NULL, 1, NULL, ?, ?, NULL)`,
        runId,
        JSON.stringify({
          phase: "execute",
          effect: { id: effectId, kind: "echo", recovery }
        }),
        `state-machine:${runId}`,
        now,
        now
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO cf_agents_state_machine_effects
          (run_id, effect_id, revision, kind, recovery, status, input_json,
           external_id, result_json, error_name, error_message, created_at,
           settled_at)
         VALUES (?, ?, 1, 'echo', ?, 'running', ?, ?, NULL, NULL, NULL, ?, NULL)`,
        runId,
        effectId,
        recovery,
        JSON.stringify({ value }),
        externalId ?? null,
        now
      );
    });
    await this.#stateMachine.resume(runId);
    return runId;
  }

  cancelRun(runId: string, reason?: string) {
    return this.#stateMachine.cancel(runId, reason);
  }

  async migrateVersionOneRun(): Promise<{
    columns: string[];
    checkpoint: string | null;
  }> {
    await this.#stateMachine.get("initialize-schema");
    const runId = `migrate_${crypto.randomUUID()}`;
    await this.ctx.storage.put("cf_agents_state_machine_schema_version", 1);
    this.ctx.storage.sql.exec("DROP TABLE cf_agents_state_machine_runs");
    this.ctx.storage.sql.exec(`CREATE TABLE cf_agents_state_machine_runs (
      run_id TEXT PRIMARY KEY,
      definition TEXT NOT NULL,
      definition_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      phase TEXT,
      checkpoint_json TEXT,
      revision INTEGER NOT NULL,
      control_json TEXT NOT NULL,
      job_id TEXT,
      result_json TEXT,
      error_name TEXT,
      error_message TEXT,
      persist INTEGER NOT NULL DEFAULT 1,
      idempotency_key TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      settled_at INTEGER
    ) WITHOUT ROWID`);
    const now = Date.now();
    const checkpoint = JSON.stringify({ phase: "first", label: "migrated" });
    this.ctx.storage.sql.exec(
      `INSERT INTO cf_agents_state_machine_runs
        (run_id, definition, definition_version, status, phase,
         checkpoint_json, revision, control_json, job_id, persist,
         created_at, updated_at)
       VALUES (?, 'pipeline', 1, 'running', 'first', ?, 0,
               '{"status":"running"}', ?, 1, ?, ?)`,
      runId,
      checkpoint,
      `state-machine:${runId}`,
      now,
      now
    );
    await this.#stateMachine.onStart();
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(cf_agents_state_machine_runs)")
      .toArray()
      .map((column) => column.name);
    const row = this.ctx.storage.sql
      .exec<{ checkpoint_json: string | null }>(
        "SELECT checkpoint_json FROM cf_agents_state_machine_runs WHERE run_id = ?",
        runId
      )
      .one();
    return { columns, checkpoint: row.checkpoint_json };
  }

  async migrateVersionThreeEffects(): Promise<{
    columns: string[];
    attempt: number;
    supportsRetrying: boolean;
  }> {
    await this.#stateMachine.get("initialize-schema-v3");
    await this.ctx.storage.put("cf_agents_state_machine_schema_version", 3);
    this.ctx.storage.sql.exec("DROP TABLE cf_agents_state_machine_effects");
    this.ctx.storage.sql.exec(`CREATE TABLE cf_agents_state_machine_effects (
      run_id TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      recovery TEXT NOT NULL CHECK (recovery IN ('safe', 'never', 'reconcile')),
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'running', 'completed', 'failed', 'interrupted'
      )),
      input_json TEXT NOT NULL,
      external_id TEXT,
      result_json TEXT,
      error_name TEXT,
      error_message TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      settled_at INTEGER,
      PRIMARY KEY (run_id, effect_id)
    ) WITHOUT ROWID`);
    this.ctx.storage.sql.exec(
      `INSERT INTO cf_agents_state_machine_effects
       (run_id, effect_id, revision, kind, recovery, status, input_json,
        attempt, created_at)
       VALUES ('migration-run', 'migration-effect', 1, 'echo', 'safe',
               'failed', '{}', 3, ?)`,
      Date.now()
    );
    await this.#stateMachine.onStart();
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>(
        "PRAGMA table_info(cf_agents_state_machine_effects)"
      )
      .toArray()
      .map((column) => column.name);
    const attempt = this.ctx.storage.sql
      .exec<{ attempt: number }>(
        `SELECT attempt FROM cf_agents_state_machine_effects
         WHERE effect_id = 'migration-effect'`
      )
      .one().attempt;
    let supportsRetrying = true;
    try {
      this.ctx.storage.sql.exec(
        `UPDATE cf_agents_state_machine_effects SET status = 'retrying'
         WHERE effect_id = 'migration-effect'`
      );
    } catch {
      supportsRetrying = false;
    }
    return { columns, attempt, supportsRetrying };
  }

  dispatchStale(runId: string) {
    return this.#stateMachine.onJob({
      attempt: 1,
      job: {
        id: `state-machine:${runId}`,
        capability: "state-machine",
        fn: "drive",
        time: Date.now(),
        payload: { runId, revision: 0 },
        retry: undefined,
        singleflight: true,
        exclusive: false,
        recoveryLoop: false,
        createdAt: Date.now()
      }
    });
  }

  pauseRun(runId: string) {
    return this.#stateMachine.pause(runId);
  }

  resumeRun(runId: string) {
    return this.#stateMachine.resume(runId);
  }

  deleteRun(runId: string) {
    return this.#stateMachine.delete(runId);
  }

  async snapshot(runId: string): Promise<HarnessSnapshot | null> {
    return (await this.#stateMachine.get(
      runId,
      "pipeline"
    )) as unknown as HarnessSnapshot | null;
  }

  async runSnapshot(runId: string): Promise<HarnessSnapshot | null> {
    return (await this.#stateMachine.get(
      runId
    )) as unknown as HarnessSnapshot | null;
  }

  committedValues(): string[] {
    return this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM state_machine_commit_probe ORDER BY rowid"
      )
      .toArray()
      .map((row) => row.value);
  }
}
