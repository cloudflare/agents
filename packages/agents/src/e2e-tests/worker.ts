/**
 * E2E test worker — agent with multiple fiber methods for eviction testing.
 * Runs under wrangler dev with persistent SQLite storage.
 *
 * Uses a short keepAliveIntervalMs (2s) so alarm-based recovery
 * happens quickly in tests instead of waiting the default 30s.
 */
import { Agent, callable, routeAgentRequest } from "agents";
import type {
  FiberInspection,
  FiberRecoveryContext as RunFiberRecoveryContext,
  FiberRecoveryResult,
  StartFiberResult
} from "agents";
import { genericObservability } from "agents/observability";
import type { Observability } from "agents/observability";

type Env = {
  RunFiberTestAgent: DurableObjectNamespace<RunFiberTestAgent>;
  SubAgentFiberParent: DurableObjectNamespace<SubAgentFiberParent>;
  SubAgentFiberChild: DurableObjectNamespace<SubAgentFiberChild>;
  PoisonRowAgent: DurableObjectNamespace<PoisonRowAgent>;
  ScanDeadlineAgent: DurableObjectNamespace<ScanDeadlineAgent>;
  ConcurrentFiberAgent: DurableObjectNamespace<ConcurrentFiberAgent>;
  PoisonBackoffAgent: DurableObjectNamespace<PoisonBackoffAgent>;
  FacetRecoveryParent: DurableObjectNamespace<FacetRecoveryParent>;
  FacetRecoveryChild: DurableObjectNamespace<FacetRecoveryChild>;
};

function fiberSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type StepResult = {
  index: number;
  value: string;
  completedAt: number;
};

export type SlowFiberSnapshot = {
  completedSteps: StepResult[];
  totalSteps: number;
};

// ── RunFiberTestAgent (uses Agent.runFiber directly, no mixin) ────────

export class RunFiberTestAgent extends Agent<Record<string, unknown>> {
  static options = { keepAliveIntervalMs: 2_000 };

  recoveredFibers: RunFiberRecoveryContext[] = [];

  override async onFiberRecovered(
    ctx: RunFiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    this.recoveredFibers.push(ctx);
    // Re-start the fiber from checkpoint
    if (ctx.name === "slowSteps") {
      void this.runFiber("slowSteps", async (fiber) => {
        const snapshot = ctx.snapshot as {
          completedSteps: Array<{ index: number; value: string }>;
          totalSteps: number;
        } | null;
        const completedSteps = snapshot?.completedSteps ?? [];
        const totalSteps = snapshot?.totalSteps ?? 0;
        const startIndex = completedSteps.length;

        for (let i = startIndex; i < totalSteps; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          completedSteps.push({ index: i, value: `step-${i}-done` });
          fiber.stash({ completedSteps: [...completedSteps], totalSteps });
        }
      }).catch(console.error);
    }
    if (ctx.name === "managedSlowComplete") {
      return {
        status: "completed",
        snapshot: {
          recovered: true,
          checkpoint: ctx.snapshot
        },
        metadata: {
          recoveredBy: "onFiberRecovered"
        }
      };
    }
  }

  @callable()
  startSlowFiber(totalSteps: number): string {
    void this.runFiber("slowSteps", async (ctx) => {
      const completedSteps: Array<{ index: number; value: string }> = [];

      for (let i = 0; i < totalSteps; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        completedSteps.push({ index: i, value: `step-${i}-done` });
        ctx.stash({ completedSteps: [...completedSteps], totalSteps });
      }
    }).catch(console.error);

    return "started";
  }

  @callable()
  async startManagedSlowFiber(
    totalSteps: number,
    idempotencyKey: string,
    mode: "complete" | "interrupt"
  ): Promise<StartFiberResult> {
    const name = mode === "complete" ? "managedSlowComplete" : "managedSlow";
    return this.startFiber(
      name,
      async (ctx) => {
        const completedSteps: StepResult[] = [];
        for (let i = 0; i < totalSteps; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          completedSteps.push({
            index: i,
            value: `managed-step-${i}-done`,
            completedAt: Date.now()
          });
          ctx.stash({ completedSteps: [...completedSteps], totalSteps });
        }
      },
      {
        idempotencyKey,
        metadata: { totalSteps, mode }
      }
    );
  }

  @callable()
  async retryManagedSlowFiberAndWait(
    totalSteps: number,
    idempotencyKey: string,
    mode: "complete" | "interrupt"
  ): Promise<StartFiberResult> {
    const name = mode === "complete" ? "managedSlowComplete" : "managedSlow";
    return this.startFiber(
      name,
      async () => {
        throw new Error("duplicate managed fiber callback should not run");
      },
      {
        idempotencyKey,
        metadata: { totalSteps, mode, duplicate: true },
        waitForCompletion: true
      }
    );
  }

  @callable()
  getFiberStatus(): {
    hasRunningFibers: boolean;
    runCount: number;
    recoveredCount: number;
    recoveredSnapshots: unknown[];
  } {
    const rows = this.sql<{ id: string; snapshot: string | null }>`
      SELECT id, snapshot FROM cf_agents_runs
    `;
    return {
      hasRunningFibers: rows.length > 0,
      runCount: rows.length,
      recoveredCount: this.recoveredFibers.length,
      recoveredSnapshots: this.recoveredFibers.map((f) => f.snapshot)
    };
  }

  @callable()
  getRecoveredFibers(): RunFiberRecoveryContext[] {
    return this.recoveredFibers;
  }

  @callable()
  async getManagedFiberByKey(
    idempotencyKey: string
  ): Promise<FiberInspection | null> {
    return this.inspectFiberByKey(idempotencyKey);
  }

  @callable()
  async getManagedFiberStatus(idempotencyKey: string): Promise<{
    runCount: number;
    recoveredCount: number;
    fiber: FiberInspection | null;
  }> {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return {
      runCount: rows[0]?.count ?? 0,
      recoveredCount: this.recoveredFibers.length,
      fiber: await this.inspectFiberByKey(idempotencyKey)
    };
  }

  @callable()
  getRunningFiberSnapshot(): unknown {
    const rows = this.sql<{ snapshot: string | null }>`
      SELECT snapshot FROM cf_agents_runs LIMIT 1
    `;
    if (rows.length === 0) return null;
    return rows[0].snapshot ? JSON.parse(rows[0].snapshot) : null;
  }
}

// ── Sub-agent runFiber recovery ───────────────────────────────────────

export class SubAgentFiberChild extends Agent<Record<string, unknown>> {
  static options = { keepAliveIntervalMs: 2_000 };

  recoveredFibers: RunFiberRecoveryContext[] = [];

  override async onFiberRecovered(
    ctx: RunFiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    this.recoveredFibers.push(ctx);
    if (ctx.name === "managedSubSlowComplete") {
      return {
        status: "completed",
        snapshot: {
          recovered: true,
          checkpoint: ctx.snapshot
        }
      };
    }
  }

  async startSlowFiber(totalSteps: number): Promise<string> {
    void this.runFiber("subSlowSteps", async (ctx) => {
      const completedSteps: Array<{ index: number; value: string }> = [];

      for (let i = 0; i < totalSteps; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        completedSteps.push({ index: i, value: `sub-step-${i}-done` });
        ctx.stash({ completedSteps: [...completedSteps], totalSteps });
      }
    }).catch(console.error);

    return "started";
  }

  async startManagedSlowFiber(
    totalSteps: number,
    idempotencyKey: string
  ): Promise<StartFiberResult> {
    return this.startFiber(
      "managedSubSlowComplete",
      async (ctx) => {
        const completedSteps: StepResult[] = [];
        for (let i = 0; i < totalSteps; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          completedSteps.push({
            index: i,
            value: `managed-sub-step-${i}-done`,
            completedAt: Date.now()
          });
          ctx.stash({ completedSteps: [...completedSteps], totalSteps });
        }
      },
      {
        idempotencyKey,
        metadata: { totalSteps }
      }
    );
  }

  getFiberStatus(): {
    hasRunningFibers: boolean;
    runCount: number;
    recoveredCount: number;
    recoveredSnapshots: unknown[];
  } {
    const rows = this.sql<{ id: string; snapshot: string | null }>`
      SELECT id, snapshot FROM cf_agents_runs
    `;
    return {
      hasRunningFibers: rows.length > 0,
      runCount: rows.length,
      recoveredCount: this.recoveredFibers.length,
      recoveredSnapshots: this.recoveredFibers.map((f) => f.snapshot)
    };
  }

  getRecoveredFibers(): RunFiberRecoveryContext[] {
    return this.recoveredFibers;
  }

  async getManagedFiberByKey(
    idempotencyKey: string
  ): Promise<FiberInspection | null> {
    return this.inspectFiberByKey(idempotencyKey);
  }

  async getManagedFiberStatus(idempotencyKey: string): Promise<{
    runCount: number;
    recoveredCount: number;
    fiber: FiberInspection | null;
  }> {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return {
      runCount: rows[0]?.count ?? 0,
      recoveredCount: this.recoveredFibers.length,
      fiber: await this.inspectFiberByKey(idempotencyKey)
    };
  }

  getRunningFiberSnapshot(): unknown {
    const rows = this.sql<{ snapshot: string | null }>`
      SELECT snapshot FROM cf_agents_runs LIMIT 1
    `;
    if (rows.length === 0) return null;
    return rows[0].snapshot ? JSON.parse(rows[0].snapshot) : null;
  }
}

export class SubAgentFiberParent extends Agent<Record<string, unknown>> {
  static options = { keepAliveIntervalMs: 2_000 };

  @callable()
  async startChildSlowFiber(
    childName: string,
    totalSteps: number
  ): Promise<string> {
    const child = await this.subAgent(SubAgentFiberChild, childName);
    return child.startSlowFiber(totalSteps);
  }

  @callable()
  async startChildManagedSlowFiber(
    childName: string,
    totalSteps: number,
    idempotencyKey: string
  ): Promise<StartFiberResult> {
    const child = await this.subAgent(SubAgentFiberChild, childName);
    return child.startManagedSlowFiber(totalSteps, idempotencyKey);
  }

  @callable()
  async getChildRunningFiberSnapshot(childName: string): Promise<unknown> {
    const child = await this.subAgent(SubAgentFiberChild, childName);
    return child.getRunningFiberSnapshot();
  }

  @callable()
  async getChildFiberStatus(childName: string): Promise<{
    hasRunningFibers: boolean;
    runCount: number;
    recoveredCount: number;
    recoveredSnapshots: unknown[];
  }> {
    const child = await this.subAgent(SubAgentFiberChild, childName);
    return child.getFiberStatus();
  }

  @callable()
  async getChildRecoveredFibers(
    childName: string
  ): Promise<RunFiberRecoveryContext[]> {
    const child = await this.subAgent(SubAgentFiberChild, childName);
    return child.getRecoveredFibers();
  }

  @callable()
  async getChildManagedFiberStatus(
    childName: string,
    idempotencyKey: string
  ): Promise<{
    runCount: number;
    recoveredCount: number;
    fiber: FiberInspection | null;
  }> {
    const child = await this.subAgent(SubAgentFiberChild, childName);
    return child.getManagedFiberStatus(idempotencyKey);
  }
}

// ── Recovery-recorder base ────────────────────────────────────────────
//
// Persists recovery signals (onFiberRecovered invocations + observability
// `fiber:recovery:skipped` events) into a durable SQL table so assertions
// survive DO eviction between polls. Counters live in storage, not memory.

abstract class RecoveryRecorderAgent extends Agent<Record<string, unknown>> {
  private _recoveryLogReady = false;

  // Custom observability impl that records skip reasons durably, then
  // forwards to the default diagnostics-channel implementation.
  override observability: Observability = {
    emit: (event) => {
      if (event.type === "fiber:recovery:skipped") {
        this._recordRecoveryEvent(
          "skipped",
          event.payload.fiberId,
          event.payload.fiberName,
          event.payload.reason
        );
      }
      genericObservability.emit(event);
    }
  };

  private _ensureRecoveryLog(): void {
    if (this._recoveryLogReady) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS test_recovery_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        fiber_id TEXT,
        fiber_name TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL
      )
    `;
    this._recoveryLogReady = true;
  }

  protected _recordRecoveryEvent(
    kind: "hook" | "skipped",
    fiberId: string | null,
    fiberName: string | null,
    reason: string | null
  ): void {
    this._ensureRecoveryLog();
    this.sql`
      INSERT INTO test_recovery_log
        (kind, fiber_id, fiber_name, reason, created_at)
      VALUES (${kind}, ${fiberId}, ${fiberName}, ${reason}, ${Date.now()})
    `;
  }

  protected _runRowCount(): number {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_runs
    `;
    return rows[0]?.count ?? 0;
  }

  protected _hookCount(): number {
    this._ensureRecoveryLog();
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM test_recovery_log WHERE kind = 'hook'
    `;
    return rows[0]?.count ?? 0;
  }

  protected _distinctHookFiberCount(): number {
    this._ensureRecoveryLog();
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(DISTINCT fiber_id) AS count
      FROM test_recovery_log WHERE kind = 'hook'
    `;
    return rows[0]?.count ?? 0;
  }

  protected _skipReasonCount(reason: string): number {
    this._ensureRecoveryLog();
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count
      FROM test_recovery_log WHERE kind = 'skipped' AND reason = ${reason}
    `;
    return rows[0]?.count ?? 0;
  }

  protected _hookTimestamps(): number[] {
    this._ensureRecoveryLog();
    const rows = this.sql<{ created_at: number }>`
      SELECT created_at FROM test_recovery_log
      WHERE kind = 'hook' ORDER BY seq ASC
    `;
    return rows.map((r) => r.created_at);
  }
}

// ── PoisonRowAgent (test 1: poison-row aging → max_age_exceeded) ───────
//
// An unmanaged fiber whose recovery hook ALWAYS throws. The orphaned
// `cf_agents_runs` row is retained for retry across alarm passes until it
// exceeds `fiberRecoveryMaxAgeMs`, at which point it is dropped and a
// `max_age_exceeded` skip is emitted.

export class PoisonRowAgent extends RecoveryRecorderAgent {
  static options = {
    keepAliveIntervalMs: 2_000,
    // Large enough to outlast the wrangler restart gap (so the retain phase
    // is observable after restart), small enough to expire within the test's
    // polling window. Age is measured from the fiber's original created_at.
    fiberRecoveryMaxAgeMs: 25_000
  };

  override async onFiberRecovered(
    ctx: RunFiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    this._recordRecoveryEvent("hook", ctx.id, ctx.name, null);
    throw new Error(`poison recovery for ${ctx.name} (${ctx.id})`);
  }

  @callable()
  startPoisonFiber(totalSteps: number): string {
    void this.runFiber("poisonSteps", async (ctx) => {
      const completedSteps: number[] = [];
      for (let i = 0; i < totalSteps; i++) {
        await fiberSleep(1000);
        completedSteps.push(i);
        ctx.stash({ completedSteps: [...completedSteps], totalSteps });
      }
    }).catch(console.error);
    return "started";
  }

  @callable()
  getPoisonStatus(): {
    runCount: number;
    hookCount: number;
    maxAgeExceededCount: number;
  } {
    return {
      runCount: this._runRowCount(),
      hookCount: this._hookCount(),
      maxAgeExceededCount: this._skipReasonCount("max_age_exceeded")
    };
  }
}

// ── ScanDeadlineAgent (test 2: scan-deadline yield → scan_deadline_exceeded)
//
// Starts many orphaned unmanaged fibers. A tiny `fiberRecoveryScanDeadlineMs`
// forces a single alarm pass to yield partway through the batch; subsequent
// passes drain the rest so every fiber is eventually recovered.

export class ScanDeadlineAgent extends RecoveryRecorderAgent {
  static options = {
    keepAliveIntervalMs: 2_000,
    // Tiny budget: one alarm pass cannot recover the whole batch.
    fiberRecoveryScanDeadlineMs: 75
  };

  override async onFiberRecovered(
    ctx: RunFiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    // A little work per fiber so cumulative scan time crosses the deadline
    // partway through the batch.
    await fiberSleep(25);
    this._recordRecoveryEvent("hook", ctx.id, ctx.name, null);
  }

  @callable()
  startManyFibers(count: number, stepCount: number): string {
    for (let n = 0; n < count; n++) {
      void this.runFiber(`scanFiber-${n}`, async (ctx) => {
        const completedSteps: number[] = [];
        for (let i = 0; i < stepCount; i++) {
          await fiberSleep(1000);
          completedSteps.push(i);
          ctx.stash({ completedSteps: [...completedSteps], index: n });
        }
      }).catch(console.error);
    }
    return "started";
  }

  @callable()
  getScanStatus(): {
    runCount: number;
    hookCount: number;
    distinctRecovered: number;
    scanDeadlineExceededCount: number;
  } {
    return {
      runCount: this._runRowCount(),
      hookCount: this._hookCount(),
      distinctRecovered: this._distinctHookFiberCount(),
      scanDeadlineExceededCount: this._skipReasonCount("scan_deadline_exceeded")
    };
  }
}

// ── ConcurrentFiberAgent (test 3: concurrent fiber recovery) ──────────
//
// Starts N concurrent fibers (a mix of managed + unmanaged), all orphaned by
// the kill. Every one must be recovered after restart — covering the gap that
// existing tests only exercise single-fiber recovery.

export class ConcurrentFiberAgent extends RecoveryRecorderAgent {
  static options = { keepAliveIntervalMs: 2_000 };

  override async onFiberRecovered(
    ctx: RunFiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    this._recordRecoveryEvent("hook", ctx.id, ctx.name, null);
    if (ctx.name.startsWith("concurrentManaged")) {
      return {
        status: "completed",
        snapshot: { recovered: true, checkpoint: ctx.snapshot },
        metadata: { recoveredBy: "onFiberRecovered" }
      };
    }
  }

  @callable()
  startConcurrentFibers(
    unmanagedCount: number,
    managedCount: number,
    stepCount: number
  ): { unmanaged: number; managed: number } {
    for (let n = 0; n < unmanagedCount; n++) {
      void this.runFiber(`concurrentUnmanaged-${n}`, async (ctx) => {
        const completedSteps: number[] = [];
        for (let i = 0; i < stepCount; i++) {
          await fiberSleep(1000);
          completedSteps.push(i);
          ctx.stash({ completedSteps: [...completedSteps], index: n });
        }
      }).catch(console.error);
    }
    for (let n = 0; n < managedCount; n++) {
      void this.startFiber(
        `concurrentManaged-${n}`,
        async (ctx) => {
          const completedSteps: number[] = [];
          for (let i = 0; i < stepCount; i++) {
            await fiberSleep(1000);
            completedSteps.push(i);
            ctx.stash({ completedSteps: [...completedSteps], index: n });
          }
        },
        { idempotencyKey: `concurrent-managed-${n}`, metadata: { index: n } }
      ).catch(console.error);
    }
    return { unmanaged: unmanagedCount, managed: managedCount };
  }

  @callable()
  getConcurrentStatus(): {
    runCount: number;
    hookCount: number;
    distinctRecovered: number;
  } {
    return {
      runCount: this._runRowCount(),
      hookCount: this._hookCount(),
      distinctRecovered: this._distinctHookFiberCount()
    };
  }

  @callable()
  async getManagedKeyStatus(
    idempotencyKey: string
  ): Promise<FiberInspection | null> {
    return this.inspectFiberByKey(idempotencyKey);
  }
}

// ── PoisonBackoffAgent (recovery-alarm backoff cadence) ───────────────
//
// `fiberRecoveryMaxAgeMs: 0` retains the orphan FOREVER, and the recovery hook
// always throws, so the row is never recovered and never aged out. The
// recovery follow-up alarm must back off exponentially (rather than firing
// every keepAliveIntervalMs) — exposed by recording each hook-attempt timestamp
// so the test can assert the inter-retry gaps grow while the row is retained.

export class PoisonBackoffAgent extends RecoveryRecorderAgent {
  static options = {
    keepAliveIntervalMs: 2_000,
    // Retain forever: the row is never aged out, so the only thing bounding the
    // retry storm is the alarm backoff.
    fiberRecoveryMaxAgeMs: 0
  };

  override async onFiberRecovered(
    ctx: RunFiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    this._recordRecoveryEvent("hook", ctx.id, ctx.name, null);
    throw new Error(`poison recovery for ${ctx.name} (${ctx.id})`);
  }

  @callable()
  startPoisonFiber(totalSteps: number): string {
    void this.runFiber("poisonBackoffSteps", async (ctx) => {
      const completedSteps: number[] = [];
      for (let i = 0; i < totalSteps; i++) {
        await fiberSleep(1000);
        completedSteps.push(i);
        ctx.stash({ completedSteps: [...completedSteps], totalSteps });
      }
    }).catch(console.error);
    return "started";
  }

  @callable()
  getBackoffStatus(): {
    runCount: number;
    hookCount: number;
    hookTimestamps: number[];
  } {
    return {
      runCount: this._runRowCount(),
      hookCount: this._hookCount(),
      hookTimestamps: this._hookTimestamps()
    };
  }
}

// ── Facet (sub-agent) multi-pass recovery ─────────────────────────────
//
// A facet child runs MANY orphaned fibers with a tiny scan deadline, so its
// recovery cannot drain in one pass. The root parent owns the physical alarm
// and re-drives the child's recovery across passes (the facet-run lease is
// retained while the child still has rows). Covers the gap that the root-DO
// tests don't exercise the facet recovery path under multi-pass churn.

export class FacetRecoveryChild extends RecoveryRecorderAgent {
  static options = {
    keepAliveIntervalMs: 2_000,
    fiberRecoveryScanDeadlineMs: 75
  };

  override async onFiberRecovered(
    ctx: RunFiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    await fiberSleep(25);
    this._recordRecoveryEvent("hook", ctx.id, ctx.name, null);
  }

  startManyFibers(count: number, stepCount: number): string {
    for (let n = 0; n < count; n++) {
      void this.runFiber(`facetFiber-${n}`, async (ctx) => {
        const completedSteps: number[] = [];
        for (let i = 0; i < stepCount; i++) {
          await fiberSleep(1000);
          completedSteps.push(i);
          ctx.stash({ completedSteps: [...completedSteps], index: n });
        }
      }).catch(console.error);
    }
    return "started";
  }

  getScanStatus(): {
    runCount: number;
    hookCount: number;
    distinctRecovered: number;
    scanDeadlineExceededCount: number;
  } {
    return {
      runCount: this._runRowCount(),
      hookCount: this._hookCount(),
      distinctRecovered: this._distinctHookFiberCount(),
      scanDeadlineExceededCount: this._skipReasonCount("scan_deadline_exceeded")
    };
  }
}

export class FacetRecoveryParent extends Agent<Record<string, unknown>> {
  static options = { keepAliveIntervalMs: 2_000 };

  @callable()
  async startChildManyFibers(
    childName: string,
    count: number,
    stepCount: number
  ): Promise<string> {
    const child = await this.subAgent(FacetRecoveryChild, childName);
    return child.startManyFibers(count, stepCount);
  }

  @callable()
  async getChildScanStatus(childName: string): Promise<{
    runCount: number;
    hookCount: number;
    distinctRecovered: number;
    scanDeadlineExceededCount: number;
  }> {
    const child = await this.subAgent(FacetRecoveryChild, childName);
    return child.getScanStatus();
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
