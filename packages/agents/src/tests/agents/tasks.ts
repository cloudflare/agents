import { Agent, getCurrentAgent } from "../../index";
import type { TaskHandlers, TaskStep } from "../../tasks";

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
}
