/**
 * E2E test worker — a minimal agent with a slow fiber for eviction testing.
 * Runs under wrangler dev with persistent SQLite storage.
 */
import { Agent, callable, routeAgentRequest } from "agents";
import {
  withFibers,
  type FiberContext,
  type FiberState,
  type FiberRecoveryContext
} from "agents/experimental/forever";

// Env type for this worker — matches wrangler.jsonc bindings
type Env = {
  FiberTestAgent: DurableObjectNamespace<FiberTestAgent>;
};

export type StepResult = {
  index: number;
  value: string;
  completedAt: number;
};

export type SlowFiberSnapshot = {
  completedSteps: StepResult[];
  totalSteps: number;
};

const FiberAgent = withFibers(Agent, { debugFibers: true });

export class FiberTestAgent extends FiberAgent<Record<string, unknown>> {
  observability = undefined;

  /**
   * A slow fiber that takes ~1 second per step.
   * Checkpoints after each step.
   */
  async slowSteps(
    payload: { totalSteps: number },
    fiberCtx: FiberContext
  ): Promise<{ completedSteps: StepResult[] }> {
    const snapshot = fiberCtx.snapshot as SlowFiberSnapshot | null;
    const completedSteps = snapshot?.completedSteps ?? [];
    const startIndex = completedSteps.length;

    for (let i = startIndex; i < payload.totalSteps; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      completedSteps.push({
        index: i,
        value: `step-${i}-done`,
        completedAt: Date.now()
      });

      this.stashFiber({
        completedSteps: [...completedSteps],
        totalSteps: payload.totalSteps
      } satisfies SlowFiberSnapshot);
    }

    return { completedSteps };
  }

  override onFiberRecovered(ctx: FiberRecoveryContext) {
    this.restartFiber(ctx.id);
  }

  @callable()
  startSlowFiber(totalSteps: number): string {
    return this.spawnFiber("slowSteps", { totalSteps });
  }

  @callable()
  getFiberStatus(fiberId: string): FiberState | null {
    return this.getFiber(fiberId);
  }

  @callable()
  async triggerAlarm(): Promise<void> {
    await this.checkFibers();
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
