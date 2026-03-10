import { Think } from "../../think";
import type {
  FiberContext,
  FiberCompleteContext,
  FiberRecoveryContext
} from "../../think";

// ── Tracking types ──────────────────────────────────────────────

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

// ── ThinkFiberTestAgent ─────────────────────────────────────────
// Extends Think with fibers = true for testing fiber integration.

export class ThinkFiberTestAgent extends Think {
  fibers = true;

  executionLog: string[] = [];
  completedFibers: CompletedFiberInfo[] = [];
  recoveredFibers: RecoveredFiberInfo[] = [];

  // ── Fiber methods (callbacks) ─────────────────────────────────

  async simpleWork(
    payload: { value: string },
    _ctx: FiberContext
  ): Promise<{ result: string }> {
    this.executionLog.push(`executed:${payload.value}`);
    return { result: payload.value };
  }

  async checkpointingWork(
    payload: { steps: string[] },
    _ctx: FiberContext
  ): Promise<{ completedSteps: string[] }> {
    const completed: string[] = [];
    for (const step of payload.steps) {
      completed.push(step);
      this.stashFiber({
        completedSteps: [...completed],
        currentStep: step
      });
      this.executionLog.push(`step:${step}`);
    }
    return { completedSteps: completed };
  }

  async failingWork(_payload: unknown, _ctx: FiberContext): Promise<void> {
    this.executionLog.push("failing");
    throw new Error("Intentional fiber error");
  }

  // ── Lifecycle hooks ───────────────────────────────────────────

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

  // ── Test-specific public methods (callable via DO RPC) ────────

  async spawn(
    methodName: string,
    payload: unknown,
    options?: { maxRetries?: number }
  ): Promise<string> {
    return this.spawnFiber(methodName, payload, options);
  }

  async getFiberState(id: string) {
    return this.getFiber(id);
  }

  async cancel(id: string): Promise<boolean> {
    return this.cancelFiber(id);
  }

  async getExecutionLog(): Promise<string[]> {
    return this.executionLog;
  }

  async getCompletedFibers(): Promise<CompletedFiberInfo[]> {
    return this.completedFibers;
  }

  async getRecoveredFibers(): Promise<RecoveredFiberInfo[]> {
    return this.recoveredFibers;
  }

  async getFiberCount(): Promise<number> {
    const result = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_fibers
    `;
    return result[0].count;
  }

  async simulateEviction(fiberId: string): Promise<void> {
    this._fiberActiveFibers.delete(fiberId);
  }

  async triggerRecovery(): Promise<void> {
    await this.checkFibers();
  }

  async waitFor(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Think overrides (minimal — just need a model for the class) ──

  override getModel(): never {
    throw new Error("Fiber tests do not use chat");
  }
}
