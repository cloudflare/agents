/**
 * Context passed to the `runFiber` callback. Provides checkpoint
 * and identity for durable execution.
 */
export type FiberContext = {
  /** Unique identifier for this fiber execution. */
  id: string;
  /** Cooperative cancellation signal for managed fiber callers. */
  signal: AbortSignal;
  /** Checkpoint data during execution. Synchronous SQLite write. */
  stash(data: unknown): void;
  /** Currently null during execution; recovered snapshots are passed to onFiberRecovered(). */
  snapshot: unknown | null;
};

export type FiberStatus =
  | "pending"
  | "running"
  | "completed"
  | "aborted"
  | "interrupted"
  | "error";

export type StartFiberOptions = {
  fiberId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  waitForCompletion?: boolean;
};

export type FiberInspection = {
  fiberId: string;
  name: string;
  idempotencyKey?: string;
  status: FiberStatus;
  snapshot?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  settledAt?: number;
};

export type StartFiberResult = FiberInspection & {
  accepted: boolean;
};

export type FiberRecoveryResult =
  | {
      status: "completed";
      snapshot?: unknown;
      metadata?: Record<string, unknown>;
    }
  | {
      status: "error";
      error?: unknown;
      snapshot?: unknown;
    }
  | {
      status: "aborted";
      reason?: string;
      snapshot?: unknown;
    }
  | {
      status: "interrupted";
      reason?: string;
      snapshot?: unknown;
    };

export type ListFibersOptions = {
  status?: FiberStatus | FiberStatus[];
  name?: string;
  limit?: number;
};

export type DeleteFibersOptions = {
  status?: FiberStatus | FiberStatus[];
  settledBefore?: Date;
  limit?: number;
};

/**
 * Context passed to the `onFiberRecovered` hook when an interrupted
 * fiber is detected after DO restart.
 */
export type FiberRecoveryContext = {
  /** Fiber ID. */
  id: string;
  /** Name passed to `runFiber`. */
  name: string;
  /** Status for managed fibers recovered through the retained ledger. */
  status?: FiberStatus;
  /** Idempotency key for managed fibers, if one was supplied. */
  idempotencyKey?: string;
  /** Metadata for managed fibers, if one was supplied. */
  metadata?: Record<string, unknown> | null;
  /** Last checkpoint data from `stash()`, or null if never stashed. */
  snapshot: unknown | null;
  /**
   * Epoch milliseconds when the fiber row was inserted (when `runFiber`
   * started). Use `Date.now() - createdAt` to gate stale recoveries.
   */
  createdAt: number;
  /** Why this recovery hook is running. */
  recoveryReason: "interrupted";
  [key: string]: unknown;
};

/** @internal The stash context a running fiber exposes to `this.stash()`. */
export type FiberStashContext = {
  id: string;
  signal: AbortSignal;
  stash: (data: unknown) => void;
};

/** @internal Options framework hosts pass when running a fiber. */
export type InternalFiberOptions = {
  signal?: AbortSignal;
  managed?: boolean;
  initialSnapshot?: unknown;
  wrapStash?: (data: unknown) => unknown;
  beforeRunCleanup?: (
    outcome: { ok: true } | { ok: false; error: unknown }
  ) => void;
};

/** @internal Raw `cf_agents_fibers` row. */
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

/** @internal Raw `cf_agents_runs` row. */
export type FiberRunRow = {
  id: string;
  name: string;
  snapshot: string | null;
  created_at: number;
  completed_at: number | null;
  outcome: "completed" | "error" | "aborted" | null;
  error_message: string | null;
};
