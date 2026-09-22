import { DurableObject } from "cloudflare:workers";
import {
  StateMachineHarness,
  createHarnessEffectRuntime,
  type HarnessRuntime
} from "../../harness";
import { Lifecycle } from "../../lifecycle";
import { StateMachine, defineMachine } from "../../state-machine";
import type { TestHarnessSnapshot } from "./harness-shared";

type WrappedHarnessState =
  | { phase: "plan"; prompt: string }
  | {
      phase: "running";
      effect: {
        id: string;
        kind: string;
        recovery: "safe" | "never" | "reconcile";
      };
    };

export class WrappedHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly #runtime: HarnessRuntime<{ prompt: string }, string> = {
    start: async (input, invocation) => {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO wrapped_harness_runs
          (execution_id, prompt, status, result)
         VALUES (?, ?, 'running', NULL)`,
        invocation.executionId,
        input.prompt
      );
    },
    inspect: async (executionId) => {
      const row = this.ctx.storage.sql
        .exec<{ status: string; result: string | null }>(
          `SELECT status, result FROM wrapped_harness_runs
           WHERE execution_id = ?`,
          executionId
        )
        .toArray()[0];
      if (!row) return { status: "not-found" } as const;
      if (row.status === "running") return { status: "running" } as const;
      if (row.status === "completed") {
        return { status: "completed", result: row.result ?? "" } as const;
      }
      return {
        status: "failed",
        error: { name: "Cancelled", message: row.result ?? "cancelled" }
      } as const;
    },
    cancel: async (executionId) => {
      this.ctx.storage.sql.exec(
        `UPDATE wrapped_harness_runs SET status = 'failed', result = 'cancelled'
         WHERE execution_id = ? AND status = 'running'`,
        executionId
      );
    }
  };
  readonly #definition = defineMachine<
    WrappedHarnessState,
    string,
    { prompt: string }
  >({
    version: 1,
    initial: (input) => ({ phase: "plan", prompt: input.prompt }),
    phases: {
      plan: (state, context) => {
        const effect = context.effects.plan<{ prompt: string }, string>(
          "wrapped",
          { prompt: state.prompt },
          {
            recovery: "reconcile",
            externalId: `${context.runId}:execution`
          }
        );
        return context.transition({ phase: "running", effect });
      },
      running: async (state, context) => {
        const outcome = await context.effects.execute<string>(state.effect);
        if (outcome.status === "completed") {
          return context.complete(outcome.output);
        }
        if (outcome.status === "failed") {
          return context.fail(new Error(outcome.error.message));
        }
        if (outcome.status === "interrupted") {
          return context.fail(new Error("wrapped execution was lost"));
        }
        return context.wait(state, {
          type: "wrapped-runtime-ready",
          key: state.effect.id,
          timeoutAt: Date.now() + 25
        });
      }
    }
  });
  readonly #machines = new StateMachine({
    definitions: { harness: this.#definition },
    effects: { wrapped: createHarnessEffectRuntime(this.#runtime) }
  });
  readonly #harness = new StateMachineHarness({
    stateMachine: this.#machines,
    definition: "harness"
  });
  readonly lifecycle = Lifecycle.install(this).use(this.#machines);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS wrapped_harness_runs (
      execution_id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT
    ) WITHOUT ROWID`);
  }

  submit(
    prompt: string,
    options?: { runId?: string; idempotencyKey?: string }
  ) {
    return this.#harness.submit({ prompt }, options);
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

  completeExecution(runId: string, result: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE wrapped_harness_runs SET status = 'completed', result = ?
       WHERE execution_id = ? AND status = 'running'`,
      result,
      `${runId}:execution`
    );
  }

  runtimeStatus(runId: string): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM wrapped_harness_runs WHERE execution_id = ?",
          `${runId}:execution`
        )
        .toArray()[0]?.status ?? null
    );
  }
}
