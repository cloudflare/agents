/**
 * Fibers capability (Layer 1). Owns the durable fiber ledger
 * (`cf_agents_fibers`) and run-registration (`cf_agents_runs`) runtime
 * queries (the CREATE TABLE / migration DDL stays in index.ts's
 * `_ensureSchema`, which owns schema versioning for all tables).
 *
 * The `Agent` class delegates its `runFiber()`/`startFiber()`/
 * `inspectFiber*()`/`listFibers()`/`cancelFiber*()`/`resolveFiber()`/
 * `deleteFibers()`/`stash()` methods plus the interrupted-fiber recovery
 * scan (`_checkRunFibers`) here; the capability talks to the agent only
 * through the narrow {@link FibersHost} slice. Calls to *overridable*
 * agent members (`onFiberRecovered`, the protected
 * `_handleInternalFiberRecovery` override point, and the public
 * `keepAlive`/`inspectFiber`/`cancelFiber`) are re-dispatched through the
 * agent instance so subclass overrides keep working exactly as before.
 *
 * The physical Durable Object alarm stays owned by the agent —
 * `_scheduleNextAlarm` arbitrates the single alarm across schedules,
 * keepAlive heartbeats, fiber recovery, facet runs, and host timers.
 * This capability only reports its candidate wake-up time
 * ({@link AgentFibers.nextRecoveryTimeMs}). Likewise the namespaced
 * recovery registry (`onRecovery` / `_matchFiberRecoveryHandler`) stays
 * in index.ts's Layer-0 host-capabilities region — the capability
 * consults it via the `matchRecoveryHandler()` host closure. Facet fiber
 * recovery (`_checkFacetRunFibers` / `_cf_checkRunFibersForFacet`) is
 * sub-agent territory and stays on the agent.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";
import type { SqlHost } from "../core/host";
import type {
  FiberContext,
  FiberStatus,
  StartFiberOptions,
  FiberInspection,
  StartFiberResult,
  FiberRecoveryResult,
  ListFibersOptions,
  DeleteFibersOptions,
  FiberRecoveryContext,
  FiberRecoveryHandler
} from "../core/host";
import type { AgentPathStep } from "./scheduler";

// Ceiling for the exponential backoff applied to the runFiber-recovery
// follow-up alarm. A scan that makes NO forward progress (every pending orphan
// row's recovery hook threw) but still has work pending backs off so a poison
// fiber — or a `fiberRecoveryMaxAgeMs: 0` "retain forever" row whose hook keeps
// throwing — does not wake the DO every `keepAliveIntervalMs` indefinitely (the
// perpetual-heartbeat hazard #1707 guards against). A scan that DID make
// progress (recovered ≥1 row, including a scan-deadline yield that drained
// some) resets the backoff so legitimate multi-pass draining stays prompt.
const FIBER_RECOVERY_MAX_BACKOFF_MS = 5 * 60_000;
// Cap the doubling exponent so `base * 2 ** n` never overflows before the
// `FIBER_RECOVERY_MAX_BACKOFF_MS` clamp applies.
const FIBER_RECOVERY_BACKOFF_MAX_EXP = 20;

/** Raw `cf_agents_fibers` row shape. */
export type FiberLedgerRow = {
  fiber_id: string;
  idempotency_key: string | null;
  name: string;
  status: FiberStatus;
  snapshot: string | null;
  metadata_json: string | null;
  error_message: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
};

const _fiberALS = new AsyncLocalStorage<{
  id: string;
  signal: AbortSignal;
  stash: (data: unknown) => void;
}>();

export type InternalFiberOptions = {
  signal?: AbortSignal;
  managed?: boolean;
  initialSnapshot?: unknown;
  wrapStash?: (data: unknown) => unknown;
  beforeRunCleanup?: (
    outcome: { ok: true } | { ok: false; error: unknown }
  ) => void;
};

type FiberEventType =
  | "fiber:run:started"
  | "fiber:run:completed"
  | "fiber:run:failed"
  | "fiber:run:interrupted"
  | "fiber:recovery:detected"
  | "fiber:recovery:attempt"
  | "fiber:recovery:handled"
  | "fiber:recovery:skipped"
  | "fiber:recovery:failed";

/**
 * The fiber-related subset of the root agent's facet RPC surface
 * (`RootFacetRpcSurface` in index.ts). Facet-originated fibers register
 * a root-side recovery lease through these.
 */
export interface FiberRootRpc {
  _cf_registerFacetRun(
    ownerPath: ReadonlyArray<AgentPathStep>,
    runId: string
  ): Promise<void>;
  _cf_unregisterFacetRun(
    ownerPath: ReadonlyArray<AgentPathStep>,
    runId: string
  ): Promise<void>;
}

/**
 * The agent surface the capability re-dispatches through so subclass
 * overrides are honored.
 */
interface FibersAgentSurface {
  /** Public, user-overridable hook for interrupted unmanaged fibers. */
  onFiberRecovered(
    ctx: FiberRecoveryContext
  ): Promise<void | FiberRecoveryResult>;
  /** Protected override point implemented by Think / AIChatAgent. */
  _handleInternalFiberRecovery(ctx: FiberRecoveryContext): Promise<boolean>;
  /** Public — facet-aware keepAlive heartbeat. */
  keepAlive(): Promise<() => void>;
  inspectFiber(fiberId: string): Promise<FiberInspection | null>;
  cancelFiber(fiberId: string, reason?: string): Promise<boolean>;
}

/** The slice of the agent the fibers capability needs. */
export interface FibersHost {
  /**
   * The agent instance — overridable methods and lifecycle hooks are
   * re-dispatched through it so subclass overrides are honored.
   */
  agent: object;
  sql: SqlHost["sql"];
  emit(type: FiberEventType, payload: Record<string, unknown>): void;
  /** `_resolvedOptions.fiberRecoveryHookTimeoutMs` on the agent. */
  fiberRecoveryHookTimeoutMs(): number;
  /** `_resolvedOptions.fiberRecoveryScanDeadlineMs` on the agent. */
  fiberRecoveryScanDeadlineMs(): number;
  /** `_resolvedOptions.fiberRecoveryMaxAgeMs` on the agent. */
  fiberRecoveryMaxAgeMs(): number;
  /** `_resolvedOptions.keepAliveIntervalMs` on the agent. */
  keepAliveIntervalMs(): number;
  /**
   * `_matchFiberRecoveryHandler` on the agent — the namespaced
   * `onRecovery` registry stays in index.ts's host-capabilities region.
   */
  matchRecoveryHandler(name: string): FiberRecoveryHandler | undefined;
  /** Whether this agent is a facet (sub-agent) of an alarm-owning root. */
  isFacet(): boolean;
  /** The agent's own facet path (empty for top-level agents). */
  selfPath(): ReadonlyArray<AgentPathStep>;
  /** Resolve the alarm-owning root agent's facet RPC surface. */
  rootAlarmOwner(): Promise<FiberRootRpc>;
}

export class AgentFibers {
  private readonly _host: FibersHost;

  /** In-memory set of fiber IDs running in this process. */
  private _runFiberActiveFibers = new Set<string>();
  /** In-memory abort controllers for managed running fibers. */
  private _managedFiberAbortControllers = new Map<string, AbortController>();
  /** In-memory executions for callers that want to await accepted work. */
  private _managedFiberExecutions = new Map<string, Promise<void>>();
  /** In-memory waiters for managed fibers reaching terminal ledger state. */
  private _managedFiberTerminalWaiters = new Map<string, Set<() => void>>();
  /** Prevents re-entrant recovery from overlapping alarm ticks. */
  private _runFiberRecoveryInProgress = false;
  /**
   * Consecutive runFiber-recovery scans that made NO forward progress
   * while work was still pending. Drives the exponential backoff of the
   * recovery follow-up alarm so a repeatedly-throwing recovery hook does not
   * busy-loop the DO. Reset to 0 whenever a scan recovers anything.
   * @internal Read by tests via the agent's `_recoveryNoProgressScans`.
   */
  _recoveryNoProgressScans = 0;

  constructor(host: FibersHost) {
    this._host = host;
  }

  private get _agent(): FibersAgentSurface {
    return this._host.agent as FibersAgentSurface;
  }

  // ── Managed fibers: idempotent durable jobs ────────────────────────

  private _isTerminalFiberStatus(status: FiberStatus): boolean {
    return (
      status === "completed" ||
      status === "aborted" ||
      status === "interrupted" ||
      status === "error"
    );
  }

  private _notifyManagedFiberTerminal(fiberId: string): void {
    const row = this._readFiber(fiberId);
    if (row && !this._isTerminalFiberStatus(row.status)) {
      return;
    }

    const waiters = this._managedFiberTerminalWaiters.get(fiberId);
    if (!waiters) {
      return;
    }

    this._managedFiberTerminalWaiters.delete(fiberId);
    for (const resolve of waiters) {
      resolve();
    }
  }

  private _waitForManagedFiberTerminal(fiberId: string): Promise<void> {
    const row = this._readFiber(fiberId);
    if (!row || this._isTerminalFiberStatus(row.status)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let waiters = this._managedFiberTerminalWaiters.get(fiberId);
      if (!waiters) {
        waiters = new Set();
        this._managedFiberTerminalWaiters.set(fiberId, waiters);
      }
      waiters.add(resolve);
    });
  }

  private _normalizeFiberStatusFilter(
    status?: FiberStatus | FiberStatus[]
  ): Set<FiberStatus> | null {
    if (!status) return null;
    return new Set(Array.isArray(status) ? status : [status]);
  }

  private _parseFiberJsonObject(
    value: string | null
  ): Record<string, unknown> | null {
    if (value === null) return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid metadata should not prevent inspection.
    }
    return null;
  }

  private _parseFiberSnapshot(value: string | null): unknown | undefined {
    if (value === null) return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }

  private _fiberErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private _stringifyFiberSnapshot(snapshot: unknown): string | null {
    return snapshot === undefined ? null : JSON.stringify(snapshot);
  }

  private _fiberRecoveryErrorMessage(
    result: FiberRecoveryResult
  ): string | null {
    if (result.status === "error") {
      return result.error === undefined
        ? null
        : this._fiberErrorMessage(result.error);
    }
    if (result.status === "aborted" || result.status === "interrupted") {
      return result.reason ?? null;
    }
    return null;
  }

  private _applyManagedFiberRecoveryResult(
    fiberId: string,
    result: FiberRecoveryResult
  ): void {
    const completedAt = Date.now();
    const snapshot = this._stringifyFiberSnapshot(result.snapshot);
    const errorMessage = this._fiberRecoveryErrorMessage(result);
    const metadata =
      result.status === "completed" && result.metadata !== undefined
        ? JSON.stringify(result.metadata)
        : undefined;

    if (metadata !== undefined) {
      this._host.sql`
        UPDATE cf_agents_fibers
        SET status = ${result.status},
            snapshot = COALESCE(${snapshot}, snapshot),
            metadata_json = ${metadata},
            error_message = ${errorMessage},
            completed_at = ${completedAt}
        WHERE fiber_id = ${fiberId}
          AND status = 'interrupted'
      `;
      this._notifyManagedFiberTerminal(fiberId);
      return;
    }

    this._host.sql`
      UPDATE cf_agents_fibers
      SET status = ${result.status},
          snapshot = COALESCE(${snapshot}, snapshot),
          error_message = ${errorMessage},
          completed_at = ${completedAt}
      WHERE fiber_id = ${fiberId}
        AND status = 'interrupted'
    `;
    this._notifyManagedFiberTerminal(fiberId);
  }

  private _settleManagedFiberExecution(
    fiberId: string,
    outcome: { ok: true } | { ok: false; error: unknown },
    signal: AbortSignal
  ): void {
    const completedAt = Date.now();
    if (outcome.ok) {
      this._host.sql`
        UPDATE cf_agents_fibers
        SET status = 'completed', completed_at = ${completedAt}
        WHERE fiber_id = ${fiberId} AND status = 'running'
      `;
      this._notifyManagedFiberTerminal(fiberId);
      return;
    }

    const message = this._fiberErrorMessage(outcome.error);
    const status: FiberStatus = signal.aborted ? "aborted" : "error";
    this._host.sql`
      UPDATE cf_agents_fibers
      SET status = ${status},
          error_message = ${message},
          completed_at = ${completedAt}
      WHERE fiber_id = ${fiberId} AND status = 'running'
    `;
    this._notifyManagedFiberTerminal(fiberId);
  }

  private _parseFiberRecoverySnapshot(
    fiberId: string,
    snapshotText: string | null
  ): unknown | null {
    if (!snapshotText) return null;
    try {
      return JSON.parse(snapshotText) as unknown;
    } catch {
      console.warn(
        `[Agent] Corrupted snapshot for fiber ${fiberId}, treating as null`
      );
      return null;
    }
  }

  private _fiberRecoveryPayload(
    ctx: FiberRecoveryContext,
    managedRow: FiberLedgerRow | null,
    startedAt?: number
  ): Record<string, unknown> {
    return {
      fiberId: ctx.id,
      fiberName: ctx.name,
      managed: managedRow !== null,
      recoveryReason: ctx.recoveryReason,
      elapsedMs: startedAt === undefined ? undefined : Date.now() - startedAt
    };
  }

  private async _withFiberRecoveryTimeout<T>(
    ctx: FiberRecoveryContext,
    operation: () => Promise<T>
  ): Promise<T> {
    const timeoutMs = this._host.fiberRecoveryHookTimeoutMs();
    if (timeoutMs <= 0) return operation();

    // Note: this bounds how long we WAIT for the operation, but does not
    // cancel it — `operation` keeps running after the timeout rejects. It is
    // applied to internal framework recovery only, which is idempotent and
    // safe to abandon mid-flight.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Fiber recovery hook timed out after ${timeoutMs}ms for "${ctx.name}" (${ctx.id})`
              )
            );
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private _recordFiberRecoveryFailure(
    ctx: FiberRecoveryContext,
    managedRow: FiberLedgerRow | null,
    error: unknown,
    startedAt: number,
    reason = "handler_error"
  ): void {
    const errorMessage = this._fiberErrorMessage(error);
    const completedAt = Date.now();
    if (managedRow) {
      this._host.sql`
        UPDATE cf_agents_fibers
        SET status = 'error',
            error_message = ${errorMessage},
            completed_at = ${completedAt}
        WHERE fiber_id = ${ctx.id}
          AND status = 'interrupted'
      `;
      this._notifyManagedFiberTerminal(ctx.id);
    }
    this._host.emit("fiber:recovery:failed", {
      ...this._fiberRecoveryPayload(ctx, managedRow, startedAt),
      error: errorMessage,
      reason
    });
  }

  private async _runFiberRecoveryHook(
    ctx: FiberRecoveryContext,
    managedRow: FiberLedgerRow | null
  ): Promise<boolean> {
    const startedAt = Date.now();
    this._host.emit(
      "fiber:recovery:attempt",
      this._fiberRecoveryPayload(ctx, managedRow)
    );
    try {
      // Namespaced registry handlers (FiberHost.onRecovery) take
      // precedence: as internal subsystems migrate onto the registry the
      // _handleInternalFiberRecovery path below shrinks away.
      const registered = this._host.matchRecoveryHandler(ctx.name);
      if (registered) {
        const recoveryResult = await this._withFiberRecoveryTimeout(ctx, () =>
          registered(ctx)
        );
        if (managedRow && recoveryResult) {
          this._applyManagedFiberRecoveryResult(ctx.id, recoveryResult);
        }
        this._host.emit("fiber:recovery:handled", {
          ...this._fiberRecoveryPayload(ctx, managedRow, startedAt),
          status: "registered"
        });
        return true;
      }

      const handled = await this._withFiberRecoveryTimeout(ctx, () =>
        this._agent._handleInternalFiberRecovery(ctx)
      );
      if (!handled) {
        const recoveryResult = await this._agent.onFiberRecovered(ctx);
        if (managedRow && recoveryResult) {
          this._applyManagedFiberRecoveryResult(ctx.id, recoveryResult);
        }
      }
      this._host.emit("fiber:recovery:handled", {
        ...this._fiberRecoveryPayload(ctx, managedRow, startedAt),
        status: handled ? "internal" : managedRow ? "managed" : "user"
      });
      return true;
    } catch (e) {
      this._recordFiberRecoveryFailure(ctx, managedRow, e, startedAt);
      console.error(
        `[Agent] Fiber recovery failed for "${ctx.name}" (${ctx.id}):`,
        e
      );
      return false;
    }
  }

  private _fiberInspectionFromRow(row: FiberLedgerRow): FiberInspection {
    const snapshot = this._parseFiberSnapshot(row.snapshot);
    const inspection: FiberInspection = {
      fiberId: row.fiber_id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at
    };

    if (row.idempotency_key !== null) {
      inspection.idempotencyKey = row.idempotency_key;
    }
    if (snapshot !== undefined) {
      inspection.snapshot = snapshot;
    }
    if (row.error_message !== null) {
      inspection.error = row.error_message;
    }
    const metadata = this._parseFiberJsonObject(row.metadata_json);
    if (metadata !== null) {
      inspection.metadata = metadata;
    }
    if (row.started_at !== null) {
      inspection.startedAt = row.started_at;
    }
    if (row.completed_at !== null) {
      inspection.settledAt = row.completed_at;
    }

    return inspection;
  }

  private async _waitForManagedFiber(
    fiberId: string
  ): Promise<FiberInspection | null> {
    const row = this._readFiber(fiberId);
    if (!row || this._isTerminalFiberStatus(row.status)) {
      return row ? this._fiberInspectionFromRow(row) : null;
    }

    if (this._managedFiberExecutions.has(fiberId)) {
      await this._waitForManagedFiberTerminal(fiberId);
      return this._agent.inspectFiber(fiberId);
    }

    await this._checkRunFibers();
    await this._waitForManagedFiberTerminal(fiberId);
    return this._agent.inspectFiber(fiberId);
  }

  private _readFiber(fiberId: string): FiberLedgerRow | null {
    const rows = this._host.sql<FiberLedgerRow>`
      SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
             error_message, created_at, started_at, completed_at
      FROM cf_agents_fibers
      WHERE fiber_id = ${fiberId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private _readFiberByKey(idempotencyKey: string): FiberLedgerRow | null {
    const rows = this._host.sql<FiberLedgerRow>`
      SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
             error_message, created_at, started_at, completed_at
      FROM cf_agents_fibers
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private _listFiberRows(options?: ListFibersOptions): FiberLedgerRow[] {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
    const statuses = this._normalizeFiberStatusFilter(options?.status);
    if (statuses) {
      return [...statuses]
        .flatMap((status) =>
          this._listFiberRowsByStatus(status, limit, options?.name)
        )
        .sort((a, b) =>
          b.created_at === a.created_at
            ? b.fiber_id.localeCompare(a.fiber_id)
            : b.created_at - a.created_at
        )
        .slice(0, limit);
    }

    if (options?.name) {
      return this._host.sql<FiberLedgerRow>`
        SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
               error_message, created_at, started_at, completed_at
        FROM cf_agents_fibers
        WHERE name = ${options.name}
        ORDER BY created_at DESC, fiber_id DESC
        LIMIT ${limit}
      `;
    }

    return this._host.sql<FiberLedgerRow>`
      SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
             error_message, created_at, started_at, completed_at
      FROM cf_agents_fibers
      ORDER BY created_at DESC, fiber_id DESC
      LIMIT ${limit}
    `;
  }

  private _listFiberRowsByStatus(
    status: FiberStatus,
    limit: number,
    name?: string
  ): FiberLedgerRow[] {
    if (name) {
      return this._host.sql<FiberLedgerRow>`
        SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
               error_message, created_at, started_at, completed_at
        FROM cf_agents_fibers
        WHERE status = ${status} AND name = ${name}
        ORDER BY created_at DESC, fiber_id DESC
        LIMIT ${limit}
      `;
    }

    return this._host.sql<FiberLedgerRow>`
      SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
             error_message, created_at, started_at, completed_at
      FROM cf_agents_fibers
      WHERE status = ${status}
      ORDER BY created_at DESC, fiber_id DESC
      LIMIT ${limit}
    `;
  }

  async inspectFiber(fiberId: string): Promise<FiberInspection | null> {
    const row = this._readFiber(fiberId);
    return row ? this._fiberInspectionFromRow(row) : null;
  }

  async inspectFiberByKey(
    idempotencyKey: string
  ): Promise<FiberInspection | null> {
    const row = this._readFiberByKey(idempotencyKey);
    return row ? this._fiberInspectionFromRow(row) : null;
  }

  async listFibers(options?: ListFibersOptions): Promise<FiberInspection[]> {
    return this._listFiberRows(options).map((row) =>
      this._fiberInspectionFromRow(row)
    );
  }

  async cancelFiber(fiberId: string, reason?: string): Promise<boolean> {
    const row = this._readFiber(fiberId);
    if (!row || this._isTerminalFiberStatus(row.status)) {
      return false;
    }

    const now = Date.now();
    this._host.sql`
      UPDATE cf_agents_fibers
      SET status = 'aborted',
          error_message = ${reason ?? null},
          completed_at = ${now}
      WHERE fiber_id = ${fiberId}
        AND status IN ('pending', 'running')
    `;
    this._managedFiberAbortControllers.get(fiberId)?.abort(reason);
    this._notifyManagedFiberTerminal(fiberId);
    return true;
  }

  async cancelFiberByKey(
    idempotencyKey: string,
    reason?: string
  ): Promise<boolean> {
    const row = this._readFiberByKey(idempotencyKey);
    return row ? this._agent.cancelFiber(row.fiber_id, reason) : false;
  }

  async resolveFiber(
    fiberId: string,
    result: FiberRecoveryResult
  ): Promise<boolean> {
    const row = this._readFiber(fiberId);
    if (!row || row.status !== "interrupted") {
      return false;
    }

    this._applyManagedFiberRecoveryResult(fiberId, result);
    return true;
  }

  async deleteFibers(options?: DeleteFibersOptions): Promise<number> {
    const statuses =
      this._normalizeFiberStatusFilter(options?.status) ??
      new Set<FiberStatus>(["completed", "aborted", "error"]);
    const terminalStatuses = [...statuses].filter((status) =>
      this._isTerminalFiberStatus(status)
    );
    if (terminalStatuses.length === 0) {
      return 0;
    }

    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    const settledBefore = options?.settledBefore?.getTime();
    const rows = terminalStatuses
      .flatMap((status) =>
        this._listTerminalFiberRowsForDelete(status, limit, settledBefore)
      )
      .sort((a, b) =>
        a.completed_at === b.completed_at
          ? a.created_at - b.created_at
          : (a.completed_at ?? 0) - (b.completed_at ?? 0)
      )
      .slice(0, limit);

    for (const row of rows) {
      this._host.sql`
        DELETE FROM cf_agents_fibers
        WHERE fiber_id = ${row.fiber_id}
          AND status IN ('completed', 'aborted', 'interrupted', 'error')
      `;
    }

    return rows.length;
  }

  private _listTerminalFiberRowsForDelete(
    status: FiberStatus,
    limit: number,
    settledBefore?: number
  ): FiberLedgerRow[] {
    if (settledBefore !== undefined) {
      return this._host.sql<FiberLedgerRow>`
        SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
               error_message, created_at, started_at, completed_at
        FROM cf_agents_fibers
        WHERE status = ${status}
          AND completed_at IS NOT NULL
          AND completed_at < ${settledBefore}
        ORDER BY completed_at ASC, created_at ASC
        LIMIT ${limit}
      `;
    }

    return this._host.sql<FiberLedgerRow>`
      SELECT fiber_id, idempotency_key, name, status, snapshot, metadata_json,
             error_message, created_at, started_at, completed_at
      FROM cf_agents_fibers
      WHERE status = ${status}
      ORDER BY completed_at ASC, created_at ASC
      LIMIT ${limit}
    `;
  }

  // ── Fibers: durable execution ───────────────────────────────────────

  /**
   * Run a function as a durable fiber (see `Agent#runFiber` for the
   * public contract).
   */
  async runFiber<T>(
    name: string,
    fn: (ctx: FiberContext) => Promise<T>
  ): Promise<T> {
    return this._runFiberInternal(nanoid(), name, fn);
  }

  /**
   * Internal framework entry point for fibers that need to compose their own
   * recovery metadata with user checkpoint data while preserving the public
   * `this.stash()` behavior (see `Agent#_runFiberWithStashWrapper`).
   */
  async _runFiberWithStashWrapper<T>(
    name: string,
    fn: (ctx: FiberContext) => Promise<T>,
    options: Pick<InternalFiberOptions, "initialSnapshot" | "wrapStash">
  ): Promise<T> {
    return this._runFiberInternal(nanoid(), name, fn, options);
  }

  async startFiber(
    name: string,
    fn: (ctx: FiberContext) => Promise<void>,
    options?: StartFiberOptions
  ): Promise<StartFiberResult> {
    const fiberId = options?.fiberId ?? nanoid();
    const idempotencyKey = options?.idempotencyKey;
    if (options?.fiberId !== undefined && options.fiberId.trim() === "") {
      throw new Error("fiberId must not be blank");
    }
    if (
      options?.idempotencyKey !== undefined &&
      options.idempotencyKey.trim() === ""
    ) {
      throw new Error("idempotencyKey must not be blank");
    }
    const existingById = this._readFiber(fiberId);
    const existingByKey = idempotencyKey
      ? this._readFiberByKey(idempotencyKey)
      : null;

    if (
      existingById &&
      existingByKey &&
      existingById.fiber_id !== existingByKey.fiber_id
    ) {
      throw new Error("fiberId and idempotencyKey refer to different fibers");
    }
    if (
      existingByKey &&
      options?.fiberId &&
      existingByKey.fiber_id !== fiberId
    ) {
      throw new Error("fiberId and idempotencyKey refer to different fibers");
    }

    const existing = existingById ?? existingByKey;
    if (existing) {
      if (
        options?.waitForCompletion &&
        !this._isTerminalFiberStatus(existing.status)
      ) {
        const waited = await this._waitForManagedFiber(existing.fiber_id);
        if (waited) {
          return {
            ...waited,
            accepted: false
          };
        }
        throw new Error(`Fiber ${existing.fiber_id} no longer exists`);
      }
      return {
        ...this._fiberInspectionFromRow(existing),
        accepted: false
      };
    }

    const now = Date.now();
    this._host.sql`
      INSERT INTO cf_agents_fibers
        (fiber_id, idempotency_key, name, status, snapshot, metadata_json,
         error_message, created_at, started_at, completed_at)
      VALUES
        (${fiberId}, ${idempotencyKey ?? null}, ${name}, 'pending', NULL,
         ${options?.metadata ? JSON.stringify(options.metadata) : null}, NULL,
         ${now}, NULL, NULL)
    `;

    const row = this._readFiber(fiberId);
    if (!row) {
      throw new Error(`Failed to create fiber ${fiberId}`);
    }

    const execution = this._executeManagedFiber(fiberId, name, fn)
      .catch((error) => {
        console.error(
          `[Agent] Managed fiber "${name}" (${fiberId}) failed:`,
          error
        );
      })
      .finally(() => {
        if (this._managedFiberExecutions.get(fiberId) === execution) {
          this._managedFiberExecutions.delete(fiberId);
        }
      });
    this._managedFiberExecutions.set(fiberId, execution);

    if (options?.waitForCompletion) {
      const completed = await this._waitForManagedFiber(fiberId);
      if (!completed) {
        throw new Error(`Fiber ${fiberId} no longer exists`);
      }
      return {
        ...completed,
        accepted: true
      };
    }

    return {
      ...this._fiberInspectionFromRow(row),
      accepted: true
    };
  }

  private async _executeManagedFiber(
    fiberId: string,
    name: string,
    fn: (ctx: FiberContext) => Promise<void>
  ): Promise<void> {
    const row = this._readFiber(fiberId);
    if (!row || row.status !== "pending") {
      return;
    }

    const controller = new AbortController();
    this._managedFiberAbortControllers.set(fiberId, controller);
    const now = Date.now();
    this._host.sql`
      UPDATE cf_agents_fibers
      SET status = 'running', started_at = ${now}
      WHERE fiber_id = ${fiberId} AND status = 'pending'
    `;

    const updated = this._readFiber(fiberId);
    if (!updated || updated.status !== "running") {
      this._managedFiberAbortControllers.delete(fiberId);
      return;
    }

    let settled = false;
    try {
      await this._runFiberInternal(fiberId, name, fn, {
        signal: controller.signal,
        managed: true,
        beforeRunCleanup: (outcome) => {
          settled = true;
          this._settleManagedFiberExecution(
            fiberId,
            outcome,
            controller.signal
          );
        }
      });
    } catch (error) {
      if (!settled) {
        this._settleManagedFiberExecution(
          fiberId,
          { ok: false, error },
          controller.signal
        );
      }
    } finally {
      this._managedFiberAbortControllers.delete(fiberId);
    }
  }

  private async _runFiberInternal<T>(
    id: string,
    name: string,
    fn: (ctx: FiberContext) => Promise<T>,
    options?: InternalFiberOptions
  ): Promise<T> {
    const signal = options?.signal ?? new AbortController().signal;
    this._host.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${id}, ${name}, NULL, ${Date.now()})
    `;
    const startedAt = Date.now();
    this._host.emit("fiber:run:started", {
      fiberId: id,
      fiberName: name,
      managed: options?.managed === true
    });
    this._runFiberActiveFibers.add(id);

    const writeSnapshot = (data: unknown) => {
      const snapshot = JSON.stringify(data);
      this._host.sql`
        UPDATE cf_agents_runs SET snapshot = ${snapshot}
        WHERE id = ${id}
      `;
      if (options?.managed) {
        this._host.sql`
          UPDATE cf_agents_fibers SET snapshot = ${snapshot}
          WHERE fiber_id = ${id}
        `;
      }
    };

    let root: FiberRootRpc | undefined;
    let registeredFacetRun = false;
    let dispose: () => void = () => {};
    try {
      if ("initialSnapshot" in (options ?? {})) {
        writeSnapshot(options?.initialSnapshot);
      }

      if (this._host.isFacet()) {
        root = await this._host.rootAlarmOwner();
        await root._cf_registerFacetRun(this._host.selfPath(), id);
        registeredFacetRun = true;
      }

      dispose = await this._agent.keepAlive();
      const stash = (data: unknown) => {
        writeSnapshot(options?.wrapStash ? options.wrapStash(data) : data);
      };

      try {
        const result = await _fiberALS.run({ id, signal, stash }, () =>
          fn({ id, signal, stash, snapshot: null })
        );
        options?.beforeRunCleanup?.({ ok: true });
        this._host.emit("fiber:run:completed", {
          fiberId: id,
          fiberName: name,
          managed: options?.managed === true,
          elapsedMs: Date.now() - startedAt
        });
        return result;
      } catch (error) {
        options?.beforeRunCleanup?.({ ok: false, error });
        this._host.emit("fiber:run:failed", {
          fiberId: id,
          fiberName: name,
          managed: options?.managed === true,
          error: this._fiberErrorMessage(error),
          elapsedMs: Date.now() - startedAt
        });
        throw error;
      }
    } finally {
      this._runFiberActiveFibers.delete(id);
      this._host.sql`DELETE FROM cf_agents_runs WHERE id = ${id}`;
      dispose();
      if (root && registeredFacetRun) {
        try {
          await root._cf_unregisterFacetRun(this._host.selfPath(), id);
        } catch (e) {
          // Leave the root-side lease behind if cleanup fails; root
          // housekeeping will re-enter the facet and prune stale rows
          // once it observes that this fiber row no longer exists.
          console.error("[Agent] Failed to unregister facet fiber:", e);
        }
      }
    }
  }

  /**
   * Checkpoint data for the currently executing fiber (see `Agent#stash`
   * for the public contract). Uses AsyncLocalStorage to identify the
   * correct fiber, so it works correctly even with concurrent fibers.
   */
  stash(data: unknown): void {
    const ctx = _fiberALS.getStore();
    if (!ctx) {
      throw new Error("stash() called outside a fiber");
    }
    ctx.stash(data);
  }

  /** Detect fibers left by a dead process (runFiber system). */
  async _checkRunFibers(): Promise<void> {
    if (this._runFiberRecoveryInProgress) return;
    this._runFiberRecoveryInProgress = true;
    const scanStartedAt = Date.now();
    const scanDeadlineMs = this._host.fiberRecoveryScanDeadlineMs();
    const fiberRecoveryMaxAgeMs = this._host.fiberRecoveryMaxAgeMs();
    // Forward progress this scan = at least one fiber was resolved (orphan row
    // deleted via recovery/age-out/managed-terminal, or a ledger-only managed
    // fiber finalized). Drives the recovery-alarm backoff in `_scheduleNextAlarm`.
    let madeProgress = false;

    try {
      const rows = this._host.sql<{
        id: string;
        name: string;
        snapshot: string | null;
        created_at: number;
      }>`SELECT id, name, snapshot, created_at FROM cf_agents_runs`;

      for (const row of rows) {
        if (scanDeadlineMs > 0 && Date.now() - scanStartedAt > scanDeadlineMs) {
          this._host.emit("fiber:recovery:skipped", {
            fiberId: row.id,
            fiberName: row.name,
            reason: "scan_deadline_exceeded",
            elapsedMs: Date.now() - scanStartedAt
          });
          break;
        }
        if (this._runFiberActiveFibers.has(row.id)) continue;

        const snapshot = this._parseFiberRecoverySnapshot(row.id, row.snapshot);
        const ctx: FiberRecoveryContext = {
          id: row.id,
          name: row.name,
          snapshot,
          createdAt: row.created_at,
          recoveryReason: "interrupted"
        };

        const managedRow = this._readFiber(row.id);
        this._host.emit("fiber:recovery:detected", {
          ...this._fiberRecoveryPayload(ctx, managedRow),
          elapsedMs: Date.now() - row.created_at
        });
        this._host.emit("fiber:run:interrupted", {
          fiberId: row.id,
          fiberName: row.name,
          managed: managedRow !== null,
          recoveryReason: "interrupted",
          elapsedMs: Date.now() - row.created_at
        });
        if (managedRow) {
          if (this._isTerminalFiberStatus(managedRow.status)) {
            this._host.sql`DELETE FROM cf_agents_runs WHERE id = ${row.id}`;
            madeProgress = true;
            this._notifyManagedFiberTerminal(row.id);
            continue;
          }

          const completedAt = Date.now();
          this._host.sql`
            UPDATE cf_agents_fibers
            SET status = 'interrupted',
                snapshot = ${row.snapshot},
                completed_at = ${completedAt}
            WHERE fiber_id = ${row.id}
              AND status IN ('pending', 'running')
          `;
          ctx.idempotencyKey = managedRow.idempotency_key ?? undefined;
          ctx.metadata = this._parseFiberJsonObject(managedRow.metadata_json);
          ctx.status = "interrupted";
        }

        const recovered = await this._runFiberRecoveryHook(ctx, managedRow);
        // Managed rows are always cleaned up (their ledger row records the
        // terminal status). Unmanaged rows are retained when recovery fails so
        // a later scan can retry — but only until they exceed the max age, at
        // which point a repeatedly-throwing hook would otherwise loop forever.
        const tooOld =
          fiberRecoveryMaxAgeMs > 0 &&
          Date.now() - row.created_at > fiberRecoveryMaxAgeMs;
        if (recovered || managedRow || tooOld) {
          if (!recovered && !managedRow && tooOld) {
            this._host.emit("fiber:recovery:skipped", {
              fiberId: row.id,
              fiberName: row.name,
              reason: "max_age_exceeded",
              elapsedMs: Date.now() - row.created_at
            });
          }
          this._host.sql`DELETE FROM cf_agents_runs WHERE id = ${row.id}`;
          madeProgress = true;
        }
        if (managedRow) {
          this._notifyManagedFiberTerminal(row.id);
        }
      }

      const ledgerOnlyRows = this._host.sql<FiberLedgerRow>`
        SELECT f.fiber_id, f.idempotency_key, f.name, f.status, f.snapshot,
               f.metadata_json, f.error_message, f.created_at, f.started_at,
               f.completed_at
        FROM cf_agents_fibers f
        LEFT JOIN cf_agents_runs r ON r.id = f.fiber_id
        WHERE f.status IN ('pending', 'running')
          AND r.id IS NULL
      `;

      for (const row of ledgerOnlyRows) {
        if (scanDeadlineMs > 0 && Date.now() - scanStartedAt > scanDeadlineMs) {
          this._host.emit("fiber:recovery:skipped", {
            fiberId: row.fiber_id,
            fiberName: row.name,
            reason: "scan_deadline_exceeded",
            elapsedMs: Date.now() - scanStartedAt,
            managed: true
          });
          break;
        }
        if (this._runFiberActiveFibers.has(row.fiber_id)) continue;

        const snapshot = this._parseFiberRecoverySnapshot(
          row.fiber_id,
          row.snapshot
        );
        const completedAt = Date.now();
        this._host.sql`
          UPDATE cf_agents_fibers
          SET status = 'interrupted',
              completed_at = ${completedAt}
          WHERE fiber_id = ${row.fiber_id}
            AND status IN ('pending', 'running')
        `;

        const ctx: FiberRecoveryContext = {
          id: row.fiber_id,
          name: row.name,
          snapshot,
          createdAt: row.created_at,
          idempotencyKey: row.idempotency_key ?? undefined,
          metadata: this._parseFiberJsonObject(row.metadata_json),
          status: "interrupted",
          recoveryReason: "interrupted"
        };
        this._host.emit("fiber:recovery:detected", {
          ...this._fiberRecoveryPayload(ctx, row),
          elapsedMs: Date.now() - row.created_at
        });
        this._host.emit("fiber:run:interrupted", {
          fiberId: row.fiber_id,
          fiberName: row.name,
          managed: true,
          recoveryReason: "interrupted",
          elapsedMs: Date.now() - row.created_at
        });

        await this._runFiberRecoveryHook(ctx, row);
        // A ledger-only fiber is finalized this pass regardless of hook outcome
        // (its ledger row is marked terminal and waiters are notified), so it
        // will not be pending next scan — that is forward progress.
        madeProgress = true;
        this._notifyManagedFiberTerminal(row.fiber_id);
      }
    } finally {
      this._runFiberRecoveryInProgress = false;
      // Update the recovery-alarm backoff streak: reset on any forward progress,
      // otherwise grow it only while work is still pending (a repeatedly-failing
      // poison hook). `_scheduleNextAlarm` reads this to space out retries.
      if (madeProgress) {
        this._recoveryNoProgressScans = 0;
      } else {
        this._recoveryNoProgressScans = this._hasPendingFiberRecovery()
          ? this._recoveryNoProgressScans + 1
          : 0;
      }
    }
  }

  /**
   * Whether any runFiber recovery work is still outstanding: orphaned
   * `cf_agents_runs` rows left by a dead process (excluding fibers currently
   * executing in memory, which already hold a keepAlive ref) or managed
   * ledger fibers stuck in a non-terminal state with no live run row.
   *
   * Used by {@link nextRecoveryTimeMs} to arm a follow-up alarm so
   * multi-pass recovery (e.g. after a scan-deadline yield, or while
   * retrying a throwing recovery hook) resumes instead of starving.
   */
  private _hasPendingFiberRecovery(): boolean {
    const runRows = this._host.sql<{ id: string }>`
      SELECT id FROM cf_agents_runs
    `;
    for (const row of runRows) {
      if (!this._runFiberActiveFibers.has(row.id)) return true;
    }

    const ledgerOnly = this._host.sql<{ count: number }>`
      SELECT COUNT(*) AS count
      FROM cf_agents_fibers f
      LEFT JOIN cf_agents_runs r ON r.id = f.fiber_id
      WHERE f.status IN ('pending', 'running')
        AND r.id IS NULL
    `;
    return (ledgerOnly[0]?.count ?? 0) > 0;
  }

  /**
   * Wall-clock time (ms) at which the runFiber-recovery follow-up alarm
   * should fire, or `null` when no recovery work is outstanding. One of
   * the candidate times arbitrated by the agent's `_scheduleNextAlarm`.
   *
   * Fibers left behind by a dead process (orphaned `cf_agents_runs` rows
   * or interrupted/pending managed ledger rows) are recovered by the
   * alarm-driven scan. A single scan can leave work behind — it yields
   * once it crosses `fiberRecoveryScanDeadlineMs`, and a
   * repeatedly-throwing unmanaged recovery hook keeps its row until it
   * ages out. Without a follow-up alarm those leftovers would starve,
   * since the orphans hold no keepAlive ref.
   *
   * The delay backs off exponentially while scans make no forward
   * progress (a poison hook that keeps throwing, or a
   * `fiberRecoveryMaxAgeMs: 0` retain-forever row) so the DO is not woken
   * every `keepAliveIntervalMs` indefinitely. A scan that recovers
   * anything resets the streak (see {@link _checkRunFibers}), so
   * legitimate multi-pass draining stays prompt.
   */
  nextRecoveryTimeMs(nowMs: number): number | null {
    if (this._hasPendingFiberRecovery()) {
      const base = this._host.keepAliveIntervalMs();
      const exp = Math.min(
        this._recoveryNoProgressScans,
        FIBER_RECOVERY_BACKOFF_MAX_EXP
      );
      const recoveryDelayMs = Math.min(
        FIBER_RECOVERY_MAX_BACKOFF_MS,
        base * 2 ** exp
      );
      return nowMs + recoveryDelayMs;
    }
    return null;
  }
}
