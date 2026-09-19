import { Agent, getCurrentAgent } from "../../index";
import type { LifecycleRouteAddress } from "../../lifecycle";
import {
  defineAsk,
  type TaskDefinitions,
  type TaskJson,
  type TaskMachine,
  type TaskRunSnapshot,
  type TaskStep,
  type TaskValue
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
    },

    /** A parent whose child lives on one of this Agent's sub-agents. */
    fanout: fanout((owner) =>
      this.subAgentRouteAddress("TaskFacetAgent", owner)
    )
  } satisfies TaskDefinitions;
}

export const Approval = defineAsk<{ what: string }, string>("approval");

type ApproverState =
  | { phase: "ask" }
  | { phase: "wait"; pending: { id: string } };

/** The seed of a `fanout` run: which sub-agent owns the child, and what. */
export type FanoutSeed = {
  owner: string;
  definition: string;
  input: TaskJson;
  background?: boolean;
};
type FanoutState =
  | { phase: "spawn"; seed: FanoutSeed }
  | { phase: "join"; child: string };

/**
 * One machine shared by the root and the facet fixtures: spawn one child
 * onto the named sub-agent of `agent`, then join it. The child's id is
 * derived from the run so a replay joins the child it already spawned.
 */
function fanout(addressOf: (owner: string) => LifecycleRouteAddress) {
  return {
    initial: (seed: FanoutSeed): FanoutState => ({ phase: "spawn", seed }),
    phases: {
      spawn: async (state, ctx) => {
        const owner = addressOf(state.seed.owner);
        const child = await ctx.spawn(state.seed.definition, state.seed.input, {
          owner,
          runId: `${ctx.id}:child`,
          background: state.seed.background === true,
          ...(state.seed.background === true ? { notify: true } : {})
        });
        return { phase: "join", child: child.runId };
      },
      join: async (state, ctx) => {
        const results = await ctx.join([state.child], { within: 60_000 });
        if (results === ctx.timedOut) return ctx.complete("timed-out");
        const [result] = results;
        if (result === undefined) return ctx.complete("missing");
        return ctx.complete(
          result.ok
            ? JSON.stringify(result.output)
            : `error:${result.error.name}`
        );
      }
    }
  } satisfies TaskMachine<FanoutState, never, string, FanoutSeed>;
}

/**
 * The sub-agent side of cross-facet children. It owns the child runs a
 * parent spawns onto it, and can itself be a parent spawning onto its own
 * sub-agent, so a note travels facet → root → facet.
 */
export class TaskFacetAgent extends Agent<Cloudflare.Env> {
  override readonly taskDefinitions = {
    greet: async (input: { name: string }, _step: TaskStep) =>
      `hello ${input.name} from ${this.name}`,

    napper: async (input: { ms: number }, step: TaskStep) => {
      await step.sleep("nap", input.ms);
      return "rested";
    },

    /** Parks on one ask with no deadline: no wake mirror on the root. */
    approver: {
      initial: { phase: "ask" } as ApproverState,
      phases: {
        ask: async (_state, ctx) => {
          const [pending] = ctx.ask(Approval, [{ what: "ship" }]);
          if (pending === undefined) return ctx.fail("no ask");
          return { phase: "wait", pending: { id: pending.id } };
        },
        wait: async (state, ctx) => {
          const answers = await ctx.answers<string>([state.pending]);
          if (answers === ctx.timedOut) return ctx.complete("timed-out");
          const [answer] = answers;
          return ctx.complete(answer === undefined ? "lapsed" : answer);
        }
      }
    } satisfies TaskMachine<ApproverState, never, string>,

    fanout: fanout((owner) =>
      this.subAgentRouteAddress("TaskFacetAgent", owner)
    )
  } satisfies TaskDefinitions;

  /** Create the sub-agent a fan-out will target, then start the fan-out. */
  async fanOut(seed: FanoutSeed): Promise<string> {
    await this.dynamicAgents.get(TaskFacetAgent, seed.owner);
    const receipt = await this.tasks.run("fanout", seed);
    return receipt.runId;
  }

  async runOf(runId: string): Promise<TaskRunSnapshot<TaskValue> | null> {
    return this.tasks.get(runId);
  }

  async cancelRun(runId: string, reason?: string): Promise<boolean> {
    return this.tasks.cancel(runId, reason);
  }
}
