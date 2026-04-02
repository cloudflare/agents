/**
 * E2E test worker — agent with multiple fiber methods for eviction testing.
 * Runs under wrangler dev with persistent SQLite storage.
 *
 * Uses a short keepAliveIntervalMs (2s) so alarm-based recovery
 * happens quickly in tests instead of waiting the default 30s.
 */
import { Agent, callable, routeAgentRequest } from "agents";
import {
  withFibers,
  type FiberContext,
  type FiberState,
  type FiberCompleteContext,
  type FiberRecoveryContext
} from "agents/experimental/forever";

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

type CompletedFiberInfo = {
  id: string;
  methodName: string;
  result: unknown;
};

type RecoveredFiberInfo = {
  id: string;
  methodName: string;
  snapshot: unknown;
  retryCount: number;
};

const FiberAgent = withFibers(Agent, { debugFibers: true });

export class FiberTestAgent extends FiberAgent<Record<string, unknown>> {
  static options = { keepAliveIntervalMs: 2_000 };

  completedFibers: CompletedFiberInfo[] = [];
  recoveredFibers: RecoveredFiberInfo[] = [];
  executionLog: string[] = [];

  // ── Fiber methods ──────────────────────────────────────────────

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

      this.executionLog.push(`step:${i}`);
    }

    return { completedSteps };
  }

  async simpleWork(
    payload: { value: string },
    _ctx: FiberContext
  ): Promise<{ result: string }> {
    this.executionLog.push(`executed:${payload.value}`);
    return { result: payload.value };
  }

  // ── Lifecycle hooks ────────────────────────────────────────────

  override onFiberComplete(ctx: FiberCompleteContext) {
    this.completedFibers.push({
      id: ctx.id,
      methodName: ctx.methodName,
      result: ctx.result
    });
  }

  override onFiberRecovered(ctx: FiberRecoveryContext) {
    this.recoveredFibers.push({
      id: ctx.id,
      methodName: ctx.methodName,
      snapshot: ctx.snapshot,
      retryCount: ctx.retryCount
    });
    this.restartFiber(ctx.id);
  }

  // ── Callable methods for test access ───────────────────────────

  @callable()
  startSlowFiber(totalSteps: number): string {
    return this.spawnFiber("slowSteps", { totalSteps });
  }

  @callable()
  startSimpleFiber(value: string): string {
    return this.spawnFiber("simpleWork", { value });
  }

  @callable()
  getFiberStatus(fiberId: string): FiberState | null {
    return this.getFiber(fiberId);
  }

  @callable()
  getCompletedFibersList(): CompletedFiberInfo[] {
    return this.completedFibers;
  }

  @callable()
  getRecoveredFibersList(): RecoveredFiberInfo[] {
    return this.recoveredFibers;
  }

  @callable()
  getExecutionLogList(): string[] {
    return this.executionLog;
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
