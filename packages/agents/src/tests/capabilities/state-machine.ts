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
           result_json, error_name, error_message, retain, idempotency_key,
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
      retain INTEGER NOT NULL DEFAULT 1,
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
         checkpoint_json, revision, control_json, job_id, retain,
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
