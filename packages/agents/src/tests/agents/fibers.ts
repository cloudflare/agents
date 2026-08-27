import { Agent, getCurrentAgent } from "../../index";
import type { FiberHandlers, FiberStep } from "../../fibers";

/**
 * Agent fixture for the `fibers` capability: subclass definitions declared on
 * the overridable `fiberDefinitions` field, driven through the Agent
 * composition root (host-context invoker, shared alarm with schedules, boot
 * recovery dispatch).
 */
export class TestFiberAgent extends Agent<Cloudflare.Env> {
  /** Step callbacks that actually ran (journal hits never append here). */
  readonly stepRuns: string[] = [];

  async noopCallback(): Promise<void> {}

  override readonly fiberDefinitions = {
    greet: async (input: { name: string }, step: FiberStep) => {
      const greeting = await step.do("compose", () => {
        this.stepRuns.push("greet:compose");
        return `hello ${input.name}`;
      });
      return {
        greeting,
        // Definition handlers run through Agent's host invocation boundary.
        hadHostContext: getCurrentAgent<TestFiberAgent>().agent === this,
        agentName: this.name
      };
    },

    napper: async (input: { ms: number }, step: FiberStep) => {
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
  } satisfies FiberHandlers;
}
