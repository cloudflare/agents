import { DurableObject } from "cloudflare:workers";
import { StateMachineHarness } from "../../harness";
import { Lifecycle } from "../../lifecycle";
import {
  StateMachine,
  defineGate,
  defineMachine,
  settleStreamOnMachineCommit,
  type MachineCommitParticipant,
  type MachineDefinition
} from "../../state-machine";
import { createMachineCommitParticipant } from "../../state-machine/commit";
import { Streams } from "../../streams";
import type { TestHarnessSnapshot } from "./harness-shared";

type NativeHarnessState =
  | {
      phase: "model-plan";
      prompt: string;
      streamId: string;
      permissionTimeoutMs: number;
    }
  | {
      phase: "model";
      prompt: string;
      streamId: string;
      permissionTimeoutMs: number;
      effect: {
        id: string;
        kind: string;
        recovery: "safe" | "never" | "reconcile";
      };
    }
  | {
      phase: "permission";
      prompt: string;
      streamId: string;
      gateId: string;
      expiresAt: number;
    }
  | {
      phase: "tool";
      streamId: string;
      effect: {
        id: string;
        kind: string;
        recovery: "safe" | "never" | "reconcile";
      };
    };

const Permission = defineGate<{ tool: string }, { approved: boolean }>(
  "permission"
);

export class NativeHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly #streams = new Streams();
  readonly #effectRuntimes = {
    echo: {
      execute: async (input: import("../../state-machine").MachineJson) => {
        const value = (input as { value: string }).value;
        if (value === "model-error" || value === "tool:exec:tool-error") {
          throw new Error(`effect failed: ${value}`);
        }
        return `effect:${value}`;
      }
    }
  };
  readonly #definition = defineMachine<
    NativeHarnessState,
    string,
    { prompt: string; streamId: string; permissionTimeoutMs: number }
  >({
    version: 1,
    initial: (input) => ({
      phase: "model-plan",
      prompt: input.prompt,
      streamId: input.streamId,
      permissionTimeoutMs: input.permissionTimeoutMs
    }),
    phases: {
      "model-plan": (state, context) => {
        const effect = context.effects.plan<{ value: string }, string>(
          "echo",
          { value: state.prompt },
          { recovery: "safe" }
        );
        return context.transition({
          phase: "model",
          prompt: state.prompt,
          streamId: state.streamId,
          permissionTimeoutMs: state.permissionTimeoutMs,
          effect
        });
      },
      model: async (state, context) => {
        const outcome = await context.effects.execute<string>(state.effect);
        if (outcome.status !== "completed") {
          return context.fail(new Error(`model effect ${outcome.status}`));
        }
        if (!state.prompt.startsWith("exec:")) {
          return context.complete(outcome.output, {
            commit: this.#outputCommit(
              context.runId,
              state.streamId,
              outcome.output
            )
          });
        }
        const expiresAt = Date.now() + state.permissionTimeoutMs;
        const gate = context.gates.open(
          Permission,
          { tool: "exec" },
          { metadata: { tool: "exec" }, expiresAt }
        );
        return context.transition({
          phase: "permission",
          prompt: state.prompt,
          streamId: state.streamId,
          gateId: gate.id,
          expiresAt
        });
      },
      permission: (state, context) => {
        if (context.wake.kind === "timeout") {
          return context.complete("expired", {
            commit: this.#outputCommit(context.runId, state.streamId, "expired")
          });
        }
        const decision = context.gates.take({
          id: state.gateId,
          kind: Permission.name
        });
        if (!decision) {
          return context.wait(state, {
            type: "state-machine:gate-answer",
            key: state.gateId,
            timeoutAt: state.expiresAt
          });
        }
        if (decision.status !== "answered") {
          return context.complete(decision.status, {
            commit: this.#outputCommit(
              context.runId,
              state.streamId,
              decision.status
            )
          });
        }
        const answer = decision.answer as { approved: boolean };
        if (!answer.approved) {
          return context.complete("denied", {
            commit: this.#outputCommit(context.runId, state.streamId, "denied")
          });
        }
        const effect = context.effects.plan<{ value: string }, string>(
          "echo",
          { value: `tool:${state.prompt}` },
          { recovery: "safe" }
        );
        return context.transition({
          phase: "tool",
          streamId: state.streamId,
          effect
        });
      },
      tool: async (state, context) => {
        const outcome = await context.effects.execute<string>(state.effect);
        return outcome.status === "completed"
          ? context.complete(outcome.output, {
              commit: this.#outputCommit(
                context.runId,
                state.streamId,
                outcome.output
              )
            })
          : context.fail(new Error(`tool effect ${outcome.status}`));
      }
    }
  } satisfies MachineDefinition<
    NativeHarnessState,
    string,
    { prompt: string; streamId: string; permissionTimeoutMs: number }
  >);
  readonly #machines = new StateMachine({
    definitions: { harness: this.#definition },
    effects: this.#effectRuntimes
  });
  readonly #harness = new StateMachineHarness({
    stateMachine: this.#machines,
    definition: "harness"
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.#streams)
    .use(this.#machines);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS native_harness_transcript (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL
    )`);
  }

  #outputCommit(
    runId: string,
    streamId: string,
    output: string
  ): MachineCommitParticipant[] {
    return [
      createMachineCommitParticipant(() => {
        this.#streams
          .__DO_NOT_USE_WILL_BREAK__sync()
          .append(streamId, { type: "output", text: output });
      }),
      createMachineCommitParticipant(() => {
        this.ctx.storage.sql.exec(
          `INSERT INTO native_harness_transcript (run_id, role, content)
           VALUES (?, 'assistant', ?)`,
          runId,
          output
        );
      }),
      settleStreamOnMachineCommit(this.#streams, streamId)
    ];
  }

  async submit(
    prompt: string,
    options?: {
      runId?: string;
      idempotencyKey?: string;
      permissionTimeoutMs?: number;
    }
  ) {
    const runId = options?.runId ?? `native_${crypto.randomUUID()}`;
    const streamId = `native:${runId}`;
    await this.#streams.open(streamId, { tag: runId });
    return this.#harness.submit(
      {
        prompt,
        streamId,
        permissionTimeoutMs: options?.permissionTimeoutMs ?? 60_000
      },
      { ...options, runId }
    );
  }

  async inspect(runId: string): Promise<TestHarnessSnapshot | null> {
    return (await this.#harness.inspect(
      runId
    )) as unknown as TestHarnessSnapshot | null;
  }

  abort(runId: string, reason?: string) {
    return this.#harness.abort(runId, reason);
  }

  pause(runId: string) {
    return this.#harness.pause(runId);
  }

  resume(runId: string) {
    return this.#harness.resume(runId);
  }

  result(runId: string) {
    return this.#harness.result(runId);
  }

  answerPermission(gateId: string, approved: boolean, eventId: string) {
    return this.#machines.answer(gateId, Permission, { approved }, { eventId });
  }

  withdrawPermission(gateId: string) {
    return this.#machines.withdrawGate(gateId);
  }

  async streamState(runId: string): Promise<string | null> {
    return (await this.#streams.status(`native:${runId}`))?.state ?? null;
  }

  transcript(runId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ content: string }>(
        `SELECT content FROM native_harness_transcript
         WHERE run_id = ? ORDER BY id`,
        runId
      )
      .toArray()
      .map((row) => row.content);
  }
}
