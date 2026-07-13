import { AsyncLocalStorage } from "node:async_hooks";
import { toErrorValue, ValidationError } from "../../kernel/errors.js";
import type { EventBus } from "../../kernel/events.js";
import type { IdSource } from "../../kernel/ids.js";
import type { Clock } from "../../ports/clock.js";
import type { KeyValueStore } from "../../ports/storage.js";
import type { KeepAlive } from "../scheduling/keep-alive.js";
import type { Scheduler } from "../scheduling/scheduler.js";

/**
 * Fibers: durable execution. A fiber is a named async closure registered
 * durably (a transient run row) *before* it executes, so an eviction mid-run
 * leaves a row behind that drives recovery on the next activation. Managed
 * fibers (`start`) additionally keep a retained ledger row with a status and
 * an optional idempotency key.
 */

/** Internal schedule id/callback used for recovery-scan backoff retries. */
export const RECOVERY_SCHEDULE_ID = "$internal:fiber-recovery";

const RUN_PREFIX = "fiber:run:";
const LEDGER_PREFIX = "fiber:ledger:";

const RECOVERY_BASE_DELAY_MS = 1_000;
const RECOVERY_MAX_DELAY_MS = 300_000; // capped at 5 minutes
const DEFAULT_RECOVERY_MAX_AGE_MS = 86_400_000; // 24h

export interface FiberContext {
  id: string;
  signal: AbortSignal;
  /** Synchronous full-replacement checkpoint persisted with the run row. */
  stash(data: unknown): void;
  /** The latest stashed snapshot (null when nothing has been stashed). */
  snapshot: unknown | null;
}

export type FiberStatus = "pending" | "running" | "completed" | "error" | "aborted" | "interrupted";

export interface FiberInspection {
  fiberId: string;
  name: string;
  status: FiberStatus;
  idempotencyKey?: string;
  metadata?: Record<string, unknown> | null;
  snapshot: unknown | null;
  error?: string;
  createdAt: number;
  settledAt?: number;
}

export interface FiberRecoveryContext extends Omit<FiberInspection, "status"> {
  status?: FiberStatus;
  recoveryReason: "interrupted";
}

export type FiberRecoveryResult = {
  status: "completed" | "error" | "aborted";
  error?: string;
  snapshot?: unknown;
};

export interface StartResult {
  fiberId: string;
  accepted: boolean;
  status: FiberStatus;
  error?: string;
}

export interface FiberService {
  /** Plain fiber: transient row, deleted on completion/error; returns the closure's value. */
  run<T>(name: string, fn: (ctx: FiberContext) => Promise<T>): Promise<T>;
  /** Managed fiber: retained ledger row with status + idempotency key. */
  start(
    name: string,
    fn: (ctx: FiberContext) => Promise<void>,
    options?: {
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
      waitForCompletion?: boolean;
    },
  ): Promise<StartResult>;
  /** Ambient checkpoint for the current fiber; throws outside a fiber. */
  stash(data: unknown): void;
  inspect(fiberId: string): FiberInspection | null;
  inspectByKey(idempotencyKey: string): FiberInspection | null;
  list(options?: { status?: FiberStatus[]; name?: string }): FiberInspection[];
  /** Cooperative cancellation: aborts the live signal and settles the managed row aborted. */
  cancel(fiberId: string, reason?: string): boolean;
  cancelByKey(idempotencyKey: string, reason?: string): boolean;
  /** App-level recovery: updates only `interrupted` managed rows. */
  resolve(fiberId: string, result: FiberRecoveryResult): boolean;
  /** Deletes retained ledger rows; defaults to settled completed|error|aborted. */
  deleteFibers(options?: { status?: FiberStatus[]; settledBefore?: number }): number;
  /** Recovery scan; call on startup + housekeeping alarm. */
  checkInterrupted(): Promise<void>;
}

/** Transient run row: exists exactly while a closure should be executing. */
interface RunRow {
  id: string;
  name: string;
  managed: boolean;
  snapshot: unknown | null;
  metadata?: Record<string, unknown> | null;
  idempotencyKey?: string;
  createdAt: number;
  /** Set once the row has been seen orphaned, so detection events fire once. */
  detected?: boolean;
  /** Consecutive failed onRecovered attempts (drives backoff). */
  recoveryAttempts?: number;
}

/** Retained managed-fiber ledger row. */
interface LedgerRow {
  fiberId: string;
  name: string;
  status: FiberStatus;
  idempotencyKey?: string;
  metadata?: Record<string, unknown> | null;
  snapshot: unknown | null;
  error?: string;
  createdAt: number;
  settledAt?: number;
}

const SETTLED: ReadonlySet<FiberStatus> = new Set(["completed", "error", "aborted"]);

function isSettled(status: FiberStatus): boolean {
  return SETTLED.has(status);
}

export function createFiberService(deps: {
  store: KeyValueStore;
  clock: Clock;
  ids: IdSource;
  bus: EventBus;
  keepAlive: KeepAlive;
  scheduler: Scheduler;
  onRecovered: (ctx: FiberRecoveryContext) => Promise<void | FiberRecoveryResult>;
  /** Give up recovering rows older than this. Default 24h; 0 = retry forever. */
  recoveryMaxAgeMs?: number;
}): FiberService {
  const { store, clock, ids, bus, keepAlive, scheduler } = deps;
  const recoveryMaxAgeMs = deps.recoveryMaxAgeMs ?? DEFAULT_RECOVERY_MAX_AGE_MS;

  /** Fibers with a live closure in this process (orphan detection excludes these). */
  const live = new Map<string, { controller: AbortController }>();
  /** Settlement waiters for managed fibers started in this process. */
  const waiters = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  /** Ambient current-fiber holder; AsyncLocalStorage keeps concurrent fibers separate. */
  const ambient = new AsyncLocalStorage<{ stash: (data: unknown) => void }>();

  const runKey = (id: string): string => `${RUN_PREFIX}${id}`;
  const ledgerKey = (id: string): string => `${LEDGER_PREFIX}${id}`;

  const getRun = (id: string): RunRow | undefined => store.get<RunRow>(runKey(id));
  const getLedger = (id: string): LedgerRow | undefined => store.get<LedgerRow>(ledgerKey(id));

  function allLedgers(): LedgerRow[] {
    return [...store.list<LedgerRow>({ prefix: LEDGER_PREFIX }).values()];
  }

  function toInspection(row: LedgerRow): FiberInspection {
    const inspection: FiberInspection = {
      fiberId: row.fiberId,
      name: row.name,
      status: row.status,
      snapshot: row.snapshot ?? null,
      metadata: row.metadata ?? null,
      createdAt: row.createdAt,
    };
    if (row.idempotencyKey !== undefined) inspection.idempotencyKey = row.idempotencyKey;
    if (row.error !== undefined) inspection.error = row.error;
    if (row.settledAt !== undefined) inspection.settledAt = row.settledAt;
    return inspection;
  }

  function ledgerByKey(idempotencyKey: string): LedgerRow | undefined {
    return allLedgers().find((row) => row.idempotencyKey === idempotencyKey);
  }

  function ensureWaiter(id: string): { promise: Promise<void>; resolve: () => void } {
    let waiter = waiters.get(id);
    if (!waiter) {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      waiter = { promise, resolve };
      waiters.set(id, waiter);
    }
    return waiter;
  }

  function releaseWaiter(id: string): void {
    const waiter = waiters.get(id);
    if (waiter) {
      waiter.resolve();
      waiters.delete(id);
    }
  }

  /** Transitions an unsettled ledger row to a terminal status. No-op once settled. */
  function settleLedger(
    id: string,
    status: "completed" | "error" | "aborted",
    patch?: { error?: string; snapshot?: unknown },
  ): boolean {
    const ledger = getLedger(id);
    if (!ledger || isSettled(ledger.status)) return false;
    const next: LedgerRow = { ...ledger, status, settledAt: clock.now() };
    if (patch?.error !== undefined) next.error = patch.error;
    if (patch?.snapshot !== undefined) next.snapshot = patch.snapshot;
    store.put(ledgerKey(id), next);
    releaseWaiter(id);
    return true;
  }

  /** Synchronous full-replacement snapshot write (run row + managed ledger). */
  function writeSnapshot(id: string, data: unknown): void {
    const row = getRun(id);
    if (row) store.put(runKey(id), { ...row, snapshot: data });
    const ledger = getLedger(id);
    if (ledger) store.put(ledgerKey(id), { ...ledger, snapshot: data });
  }

  /** Shared execution path: keep-alive held, run row deleted afterward, events emitted. */
  async function execute<T>(row: RunRow, fn: (ctx: FiberContext) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    live.set(row.id, { controller });
    const release = keepAlive.acquire();
    const startedAt = clock.now();

    const ctx: FiberContext = {
      id: row.id,
      signal: controller.signal,
      snapshot: row.snapshot ?? null,
      stash(data: unknown): void {
        writeSnapshot(row.id, data);
        ctx.snapshot = data;
      },
    };

    bus.emit("fiber:run:started", { fiberId: row.id, fiberName: row.name, managed: row.managed });
    try {
      const result = await ambient.run({ stash: ctx.stash }, () => fn(ctx));
      store.delete(runKey(row.id));
      bus.emit("fiber:run:completed", {
        fiberId: row.id,
        fiberName: row.name,
        managed: row.managed,
        elapsedMs: clock.now() - startedAt,
      });
      return result;
    } catch (err) {
      store.delete(runKey(row.id));
      bus.emit("fiber:run:failed", {
        fiberId: row.id,
        fiberName: row.name,
        managed: row.managed,
        elapsedMs: clock.now() - startedAt,
        error: toErrorValue(err),
      });
      throw err;
    } finally {
      live.delete(row.id);
      release();
    }
  }

  function run<T>(name: string, fn: (ctx: FiberContext) => Promise<T>): Promise<T> {
    const id = ids.newId("fiber");
    const row: RunRow = { id, name, managed: false, snapshot: null, createdAt: clock.now() };
    store.put(runKey(id), row); // registered durably before the closure runs
    return execute(row, fn);
  }

  async function start(
    name: string,
    fn: (ctx: FiberContext) => Promise<void>,
    options?: {
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
      waitForCompletion?: boolean;
    },
  ): Promise<StartResult> {
    const key = options?.idempotencyKey;
    if (key !== undefined) {
      const existing = ledgerByKey(key);
      if (existing) {
        // Duplicate: return the retained status instead of re-running. When the
        // original is still in flight here and the caller wants completion, join it.
        if (options?.waitForCompletion && !isSettled(existing.status)) {
          const waiter = waiters.get(existing.fiberId);
          if (waiter) await waiter.promise;
        }
        const current = getLedger(existing.fiberId) ?? existing;
        const result: StartResult = { fiberId: current.fiberId, accepted: false, status: current.status };
        if (current.error !== undefined) result.error = current.error;
        return result;
      }
    }

    const id = ids.newId("fiber");
    const now = clock.now();
    const metadata = options?.metadata ?? null;

    const ledger: LedgerRow = {
      fiberId: id,
      name,
      status: "pending",
      snapshot: null,
      metadata,
      createdAt: now,
    };
    if (key !== undefined) ledger.idempotencyKey = key;
    store.put(ledgerKey(id), ledger);

    const row: RunRow = { id, name, managed: true, snapshot: null, metadata, createdAt: now };
    if (key !== undefined) row.idempotencyKey = key;
    store.put(runKey(id), row); // registered durably before the closure runs

    const waiter = ensureWaiter(id);
    store.put(ledgerKey(id), { ...ledger, status: "running" });

    // Background settlement: no automatic retries; errors become ledger values.
    void execute(row, fn).then(
      () => settleLedger(id, "completed"),
      (err) => settleLedger(id, "error", { error: toErrorValue(err).message }),
    );

    if (options?.waitForCompletion) {
      await waiter.promise;
      const final = getLedger(id)!;
      const result: StartResult = { fiberId: id, accepted: true, status: final.status };
      if (final.error !== undefined) result.error = final.error;
      return result;
    }
    return { fiberId: id, accepted: true, status: "running" };
  }

  function stash(data: unknown): void {
    const holder = ambient.getStore();
    if (!holder) {
      throw new ValidationError("stash() called outside of a fiber");
    }
    holder.stash(data);
  }

  function inspect(fiberId: string): FiberInspection | null {
    const ledger = getLedger(fiberId);
    if (ledger) return toInspection(ledger);
    const row = getRun(fiberId);
    if (row && !row.managed) {
      // A plain fiber is only visible while its run row exists.
      return {
        fiberId: row.id,
        name: row.name,
        status: "running",
        snapshot: row.snapshot ?? null,
        metadata: row.metadata ?? null,
        createdAt: row.createdAt,
      };
    }
    return null;
  }

  function inspectByKey(idempotencyKey: string): FiberInspection | null {
    const ledger = ledgerByKey(idempotencyKey);
    return ledger ? toInspection(ledger) : null;
  }

  function list(options?: { status?: FiberStatus[]; name?: string }): FiberInspection[] {
    const managed = allLedgers().map(toInspection);
    const plain = [...store.list<RunRow>({ prefix: RUN_PREFIX }).values()]
      .filter((row) => !row.managed)
      .map((row) => inspect(row.id))
      .filter((f): f is FiberInspection => f !== null);
    return [...managed, ...plain].filter((f) => {
      if (options?.status && !options.status.includes(f.status)) return false;
      if (options?.name !== undefined && f.name !== options.name) return false;
      return true;
    });
  }

  function cancel(fiberId: string, reason?: string): boolean {
    const liveEntry = live.get(fiberId);
    // Settle before aborting so the terminal status wins the race against the
    // closure's own abort-driven throw.
    const settled = settleLedger(fiberId, "aborted", reason !== undefined ? { error: reason } : {});
    if (liveEntry) {
      liveEntry.controller.abort(reason);
      return true;
    }
    if (settled) {
      // No live execution to clean up after itself: drop the orphan run row.
      store.delete(runKey(fiberId));
    }
    return settled;
  }

  function cancelByKey(idempotencyKey: string, reason?: string): boolean {
    const ledger = ledgerByKey(idempotencyKey);
    return ledger ? cancel(ledger.fiberId, reason) : false;
  }

  function resolve(fiberId: string, result: FiberRecoveryResult): boolean {
    const ledger = getLedger(fiberId);
    if (!ledger || ledger.status !== "interrupted") return false;
    const next: LedgerRow = { ...ledger, status: result.status, settledAt: clock.now() };
    if (result.error !== undefined) next.error = result.error;
    if (result.snapshot !== undefined) next.snapshot = result.snapshot;
    store.put(ledgerKey(fiberId), next);
    // Any lingering run row would re-mark the ledger interrupted on the next scan.
    store.delete(runKey(fiberId));
    releaseWaiter(fiberId);
    return true;
  }

  function deleteFibers(options?: { status?: FiberStatus[]; settledBefore?: number }): number {
    const statuses = options?.status ?? [...SETTLED];
    let count = 0;
    for (const ledger of allLedgers()) {
      if (!statuses.includes(ledger.status)) continue;
      if (options?.settledBefore !== undefined) {
        if (ledger.settledAt === undefined || ledger.settledAt >= options.settledBefore) continue;
      }
      store.delete(ledgerKey(ledger.fiberId));
      count += 1;
    }
    return count;
  }

  async function checkInterrupted(): Promise<void> {
    const rows = [...store.list<RunRow>({ prefix: RUN_PREFIX }).values()];
    let minRetryDelay: number | null = null;

    for (const stored of rows) {
      if (live.has(stored.id)) continue; // not an orphan: closure is running here
      let row = stored;

      if (!row.detected) {
        bus.emit("fiber:run:interrupted", { fiberId: row.id, fiberName: row.name, managed: row.managed });
        bus.emit("fiber:recovery:detected", { fiberId: row.id, fiberName: row.name, managed: row.managed });
        const ledger = getLedger(row.id);
        if (ledger && !isSettled(ledger.status) && ledger.status !== "interrupted") {
          store.put(ledgerKey(row.id), { ...ledger, status: "interrupted" });
        }
        row = { ...row, detected: true };
        store.put(runKey(row.id), row);
      }

      const now = clock.now();
      if (recoveryMaxAgeMs !== 0 && now - row.createdAt > recoveryMaxAgeMs) {
        store.delete(runKey(row.id));
        bus.emit("fiber:recovery:skipped", {
          fiberId: row.id,
          fiberName: row.name,
          reason: "max_age_exceeded",
        });
        continue;
      }

      const attempt = (row.recoveryAttempts ?? 0) + 1;
      bus.emit("fiber:recovery:attempt", { fiberId: row.id, fiberName: row.name, attempt });

      const ctx: FiberRecoveryContext = {
        fiberId: row.id,
        name: row.name,
        snapshot: row.snapshot ?? null,
        metadata: row.metadata ?? null,
        createdAt: row.createdAt,
        recoveryReason: "interrupted",
      };
      if (row.idempotencyKey !== undefined) ctx.idempotencyKey = row.idempotencyKey;
      if (row.managed) ctx.status = "interrupted";

      try {
        const result = await deps.onRecovered(ctx);
        if (row.managed && result) {
          resolve(row.id, result);
        }
        // Plain rows are simply dropped; managed rows without a result stay interrupted.
        store.delete(runKey(row.id));
        bus.emit("fiber:recovery:handled", {
          fiberId: row.id,
          fiberName: row.name,
          ...(result ? { status: result.status } : {}),
        });
      } catch (err) {
        store.put(runKey(row.id), { ...row, recoveryAttempts: attempt });
        bus.emit("fiber:recovery:failed", {
          fiberId: row.id,
          fiberName: row.name,
          attempt,
          error: toErrorValue(err),
        });
        const delay = Math.min(RECOVERY_BASE_DELAY_MS * 2 ** (attempt - 1), RECOVERY_MAX_DELAY_MS);
        minRetryDelay = minRetryDelay === null ? delay : Math.min(minRetryDelay, delay);
      }
    }

    if (minRetryDelay !== null) {
      scheduler.create({ kind: "once", at: clock.now() + minRetryDelay }, RECOVERY_SCHEDULE_ID, undefined, {
        id: RECOVERY_SCHEDULE_ID,
      });
    } else {
      scheduler.cancel(RECOVERY_SCHEDULE_ID);
    }
  }

  return {
    run,
    start,
    stash,
    inspect,
    inspectByKey,
    list,
    cancel,
    cancelByKey,
    resolve,
    deleteFibers,
    checkInterrupted,
  };
}
