/**
 * E2E test worker — a minimal agent with a slow fiber for eviction testing.
 * Runs under wrangler dev with persistent SQLite storage.
 */
import {
  Agent,
  callable,
  routeAgentRequest,
  type experimental_FiberContext,
  type experimental_FiberState,
  type experimental_FiberRecoveryContext
} from "agents";

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

export class FiberTestAgent extends Agent<Record<string, unknown>> {
  static override options = { hibernate: true, experimental_debugFibers: true };
  observability = undefined;

  /**
   * A slow fiber that takes ~1 second per step.
   * Checkpoints after each step.
   */
  async slowSteps(
    payload: { totalSteps: number },
    fiberCtx: experimental_FiberContext
  ): Promise<{ completedSteps: StepResult[] }> {
    const snapshot = fiberCtx.snapshot as SlowFiberSnapshot | null;
    const completedSteps = snapshot?.completedSteps ?? [];
    const startIndex = completedSteps.length;

    for (let i = startIndex; i < payload.totalSteps; i++) {
      // ~1 second per step
      await new Promise((resolve) => setTimeout(resolve, 1000));

      completedSteps.push({
        index: i,
        value: `step-${i}-done`,
        completedAt: Date.now()
      });

      this.experimental_stashFiber({
        completedSteps: [...completedSteps],
        totalSteps: payload.totalSteps
      } satisfies SlowFiberSnapshot);
    }

    return { completedSteps };
  }

  override experimental_onFiberRecovered(
    ctx: experimental_FiberRecoveryContext
  ) {
    this.experimental_restartFiber(ctx.id);
  }

  @callable()
  startSlowFiber(totalSteps: number): string {
    return this.experimental_spawnFiber("slowSteps", { totalSteps });
  }

  @callable()
  getFiberStatus(fiberId: string): experimental_FiberState | null {
    return this.experimental_getFiber(fiberId);
  }

  /**
   * Manually trigger the alarm handler.
   * In production, alarms fire automatically. In wrangler dev,
   * persisted alarms don't survive process restarts, so we
   * trigger recovery manually for e2e testing.
   */
  @callable()
  async triggerAlarm(): Promise<void> {
    await this.alarm();
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
