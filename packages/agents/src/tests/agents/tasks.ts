import { Agent, getCurrentAgent } from "../../index";
import type {
  TaskHandlers,
  TaskRunSnapshot,
  TaskStep,
  TaskValue
} from "../../tasks";

/**
 * Agent fixture for the `tasks` capability: subclass definitions declared on
 * the overridable `taskDefinitions` field, driven through the Agent
 * composition root (host-context invoker, shared alarm with schedules, boot
 * recovery dispatch).
 */
export class TestTaskAgent extends Agent<Cloudflare.Env> {
  /** Step callbacks that actually ran (journal hits never append here). */
  readonly stepRuns: string[] = [];

  async noopCallback(): Promise<void> {}

  override readonly taskDefinitions = {
    greet: async (input: { name: string }, step: TaskStep) => {
      const greeting = await step.do("compose", () => {
        this.stepRuns.push("greet:compose");
        return `hello ${input.name}`;
      });
      return {
        greeting,
        // Definition handlers run through Agent's host invocation boundary.
        hadHostContext: getCurrentAgent<TestTaskAgent>().agent === this,
        agentName: this.name
      };
    },

    napper: async (input: { ms: number }, step: TaskStep) => {
      await step.do("before", () => {
        this.stepRuns.push("napper:before");
        return "before";
      });
      await step.sleep("nap", input.ms);
      await step.do("after", () => {
        this.stepRuns.push("napper:after");
        return "after";
      });
      return "rested";
    }
  } satisfies TaskHandlers;

  async prepareDueNapper(runId: string): Promise<void> {
    await this.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
      "napper",
      { ms: 60_000 },
      { runId }
    );
    await this.tasks.onRoute({
      source: undefined,
      payload: { type: "dispatch", runId }
    });

    const snapshot = await this.tasks.get(runId);
    if (snapshot?.state !== "waiting") {
      throw new Error(
        `Task ${runId} did not reach waiting state: ${snapshot?.state}`
      );
    }
    const past = Date.now() - 1_000;
    this
      .sql`UPDATE cf_agents_task_runs SET next_at = ${past} WHERE run_id = ${runId}`;
    this
      .sql`UPDATE cf_agents_task_steps SET next_at = ${past} WHERE run_id = ${runId}`;
  }

  async inspectTask(runId: string): Promise<{
    snapshot: TaskRunSnapshot<TaskValue> | null;
    stepRuns: string[];
  }> {
    return {
      snapshot: await this.tasks.get(runId),
      stepRuns: [...this.stepRuns]
    };
  }
}
