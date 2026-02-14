import { Agent, callable } from "../../index.ts";
import {
  withFibers,
  type FiberState,
  type FiberCompleteContext,
  type FiberRecoveryContext
} from "../../experimental/forever.ts";

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

// Apply the fiber mixin to Agent
const FiberAgent = withFibers(Agent, { debugFibers: true });

export class TestFiberAgent extends FiberAgent<Record<string, unknown>> {
  observability = undefined;

  // ── Tracking arrays for test assertions ──────────────────────────

  executionLog: string[] = [];
  completedFibers: CompletedFiberInfo[] = [];
  recoveredFibers: RecoveredFiberInfo[] = [];
  testKeepAliveCount = 0;

  // ── Fiber methods (callbacks) ────────────────────────────────────

  async simpleWork(payload: { value: string }) {
    this.executionLog.push(`executed:${payload.value}`);
    return { result: payload.value };
  }

  async checkpointingWork(payload: { steps: string[] }) {
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

  async failingWork(_payload: unknown) {
    this.executionLog.push("failing");
    throw new Error("Intentional fiber error");
  }

  failCount = 0;

  async failOnceThenSucceed(payload: { value: string }) {
    this.failCount++;
    if (this.failCount <= 1) {
      this.executionLog.push("fail-once");
      throw new Error("First attempt fails");
    }
    this.executionLog.push(`succeed:${payload.value}`);
    return { result: payload.value };
  }

  async slowWork(payload: { durationMs: number }) {
    this.executionLog.push("slow-start");
    await new Promise((resolve) => setTimeout(resolve, payload.durationMs));
    this.executionLog.push("slow-end");
    return { done: true };
  }

  // ── Lifecycle hooks ──────────────────────────────────────────────

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

  // ── @callable() methods for test access ──────────────────────────

  @callable()
  async spawn(
    methodName: string,
    payload: unknown,
    options?: { maxRetries?: number }
  ): Promise<string> {
    return this.spawnFiber(methodName as keyof this, payload, options);
  }

  @callable()
  async getFiberState(id: string): Promise<FiberState | null> {
    return this.getFiber(id);
  }

  @callable()
  async cancel(id: string): Promise<boolean> {
    return this.cancelFiber(id);
  }

  @callable()
  async getExecutionLog(): Promise<string[]> {
    return this.executionLog;
  }

  @callable()
  async resetExecutionLog(): Promise<void> {
    this.executionLog = [];
  }

  @callable()
  async getCompletedFibers(): Promise<CompletedFiberInfo[]> {
    return this.completedFibers;
  }

  @callable()
  async getRecoveredFibers(): Promise<RecoveredFiberInfo[]> {
    return this.recoveredFibers;
  }

  @callable()
  async resetFailCount(): Promise<void> {
    this.failCount = 0;
  }

  @callable()
  async startKeepAlive(): Promise<string> {
    const dispose = await this.keepAlive();
    this._testKeepAliveDisposer = dispose;
    this.testKeepAliveCount++;
    return "started";
  }

  @callable()
  async stopKeepAlive(): Promise<string> {
    if (this._testKeepAliveDisposer) {
      this._testKeepAliveDisposer();
      this._testKeepAliveDisposer = null;
      this.testKeepAliveCount--;
    }
    return "stopped";
  }

  @callable()
  async getKeepAliveCount(): Promise<number> {
    return this.testKeepAliveCount;
  }

  @callable()
  async getHeartbeatScheduleCount(): Promise<number> {
    const result = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_schedules
      WHERE callback = '_cf_fiberHeartbeat'
    `;
    return result[0].count;
  }

  private _testKeepAliveDisposer: (() => void) | null = null;

  // ── Simulate eviction (manipulate SQLite directly) ───────────────

  @callable()
  async simulateEviction(fiberId: string): Promise<void> {
    this._fiberActiveFibers.delete(fiberId);
  }

  @callable()
  async setFiberStatusForTest(fiberId: string, status: string): Promise<void> {
    const now = Date.now();
    this.sql`
      UPDATE cf_agents_fibers
      SET status = ${status}, updated_at = ${now}
      WHERE id = ${fiberId}
    `;
  }

  @callable()
  async triggerAlarm(): Promise<void> {
    // Call checkFibers directly for immediate recovery (tests only).
    // In production, the heartbeat schedule triggers this automatically.
    await this.checkFibers();
  }

  @callable()
  async waitFor(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  @callable()
  async getFiberCount(): Promise<number> {
    const result = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_fibers
    `;
    return result[0].count;
  }

  @callable()
  async setFiberTimestampsForTest(
    fiberId: string,
    completedAt: number,
    updatedAt: number
  ): Promise<void> {
    this.sql`
      UPDATE cf_agents_fibers
      SET completed_at = ${completedAt}, updated_at = ${updatedAt}
      WHERE id = ${fiberId}
    `;
  }

  @callable()
  async resetCleanupTimerForTest(): Promise<void> {
    this._fiberLastCleanupTime = 0;
  }

  @callable()
  async getFibersByStatus(
    status: string
  ): Promise<Array<{ id: string; callback: string; retry_count: number }>> {
    return this.sql<{
      id: string;
      callback: string;
      retry_count: number;
    }>`
      SELECT id, callback, retry_count FROM cf_agents_fibers WHERE status = ${status}
    `;
  }
}
