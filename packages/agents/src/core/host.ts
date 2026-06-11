/**
 * Host capability interfaces (Layer 0 of the modular architecture).
 *
 * These are the narrow seams that every framework module is written
 * against. The `Agent` class implements all of them; tests implement
 * fakes. See `design/rfc-modular-architecture.md` for the full design.
 *
 * ## Platform-polyfill rule
 *
 * Several of these capabilities are expected to move into the Durable
 * Object runtime one day (durable fibers/tasks, named durable timers,
 * structured interruption reasons, per-object forensics). Every interface
 * here must therefore be specifiable WITHOUT mentioning SQLite, tables,
 * or the single physical alarm: the SQL-backed implementations inside
 * `Agent` are userspace polyfills behind platform-shaped interfaces.
 * When the runtime ships a native equivalent, an adapter satisfies the
 * same interface and nothing above this layer changes. Corollaries:
 *
 * - Snapshots and payloads are opaque values, never rows.
 * - Timer keys carry explicit identity and payload
 *   (e.g. `chat-recovery:<incident>:continue`).
 * - Interruption reasons are a closed structured union, interpreted in
 *   exactly one place (the polyfill). Framework code must never
 *   string-match platform error messages.
 * - Backing tables are never a public read surface; forensics views
 *   registered through {@link DiagnosticsHost} are.
 *
 * ## Host lifecycle contract
 *
 * Initialization ordering is part of this spec, for any implementation:
 *
 * ```
 * construct → migrations → module init (incl. user onStart)
 *           → recovery dispatch → traffic
 * ```
 *
 * {@link FiberHost.onRecovery} and {@link TimerHost.onTimer} handlers
 * are never invoked before module initialization completes, so recovery
 * decisions always see fully restored in-memory state.
 */

import type { Disposable } from "./events";

/** Values that can be bound as parameters in a host SQL query. */
export type SqlValue = string | number | boolean | null;

/**
 * An idempotent, namespaced schema migration owned by a single module.
 * Migrations for a namespace run in array order exactly once.
 */
export type HostMigration = {
  /** Unique id within the namespace, e.g. "001-create-incident-table". */
  id: string;
  apply(sql: SqlHost["sql"]): void;
};

/**
 * Durable SQL access. Each module owns its tables (single-writer) and
 * registers its own migrations under a namespace; no module touches
 * another module's tables.
 */
export interface SqlHost {
  sql<T = Record<string, SqlValue>>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): T[];
  registerMigrations(namespace: string, migrations: HostMigration[]): void;
}

/**
 * Durable key-value access, for small per-key records (recovery
 * incidents, progress markers, request context) where a table is
 * overkill.
 */
export interface KvHost {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T = unknown>(prefix: string): Promise<Map<string, T>>;
}

export type TimerHandler = (key: string, payload: unknown) => Promise<void>;

/**
 * Named, durable, logical timers. The polyfill multiplexes them over the
 * single Durable Object alarm; a future runtime may provide them
 * natively. Setting a timer with an existing key replaces it. Handlers
 * claim a key prefix (e.g. "scheduler:", "chat-recovery:") and must be
 * idempotent — a timer may fire more than once across restarts.
 */
export interface TimerHost {
  setTimer(key: string, at: number, payload?: unknown): Promise<void>;
  cancelTimer(key: string): Promise<void>;
  onTimer(prefix: string, handler: TimerHandler): Disposable;
}

/**
 * Eviction control for long-running in-memory work. `keepAlive` returns
 * a release function; prefer `keepAliveWhile` which releases on settle.
 */
export interface LifetimeHost {
  keepAlive(): Promise<() => void>;
  keepAliveWhile<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Why a fiber stopped without reaching a terminal state.
 *
 * Structured replacement for matching platform error strings ("This
 * script has been upgraded", "Durable Object reset because its code was
 * updated", …). Only the FiberHost implementation may translate platform
 * signals into this union.
 */
export type InterruptionReason =
  | { kind: "code-updated" }
  | { kind: "eviction" }
  | { kind: "exception"; error: { name: string; message: string } }
  | { kind: "cancelled" }
  | { kind: "unknown"; detail?: string };

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
  /**
   * Structured classification of the interruption, when the
   * implementation can determine one. Today the polyfill leaves this
   * undefined; it becomes reliable once the runtime reports structured
   * reset reasons.
   */
  reason?: InterruptionReason;
  [key: string]: unknown;
};

export type FiberRecoveryHandler = (
  ctx: FiberRecoveryContext
) => Promise<FiberRecoveryResult | undefined | void>;

/**
 * Durable execution. A fiber registers itself durably before running,
 * checkpoints via {@link FiberContext.stash}, and — if the isolate dies
 * mid-flight — is reported as interrupted after restart.
 *
 * Recovery dispatch is a namespaced registry, not a single override:
 * fiber names are namespaced ("chat:turn:…", "myapp:…") and an
 * interrupted fiber routes to the handler owning the longest matching
 * prefix. Names with no registered handler fall through to the
 * `Agent.onFiberRecovered` override for back-compat.
 */
export interface FiberHost {
  startFiber(
    name: string,
    fn: (ctx: FiberContext) => Promise<void>,
    options?: StartFiberOptions
  ): Promise<StartFiberResult>;
  inspectFiber(fiberId: string): Promise<FiberInspection | null>;
  listFibers(options?: ListFibersOptions): Promise<FiberInspection[]>;
  /** Returns false if the fiber is unknown or already terminal. */
  cancelFiber(fiberId: string, reason?: string): Promise<boolean>;
  onRecovery(namespace: string, handler: FiberRecoveryHandler): Disposable;
}

/**
 * An observability event emitted by a module. Aligned with the event
 * shapes in `src/observability`; kept structural here so the host layer
 * has no dependency on a concrete event catalog.
 */
export type HostEvent = {
  type: string;
  payload?: Record<string, unknown>;
};

export interface EventHost {
  /**
   * Named `emitEvent` (not `emit`) so the method can live flat on the
   * `Agent` class without colliding with userland subclass methods.
   */
  emitEvent(event: HostEvent): void;
}

export type HostConnectionInfo = {
  id: string;
  tags: readonly string[];
};

/**
 * Live client connections. Explicitly optional and async-tolerant:
 * hibernated WebSockets and facet/root boundaries can make connection
 * access cross-DO native I/O, and a facet may have no connection surface
 * at all. Modules must tolerate having no live reader — durable logs
 * (e.g. the chunk log) are the source of truth, connections are an
 * optimization.
 */
export interface ConnectionHost {
  broadcast(msg: string, exclude?: string[]): void | Promise<void>;
  send(connectionId: string, msg: string): void | Promise<void>;
  connections(tag?: string): Iterable<HostConnectionInfo>;
}

/**
 * A production-safe, optionally scrubbed snapshot of one agent's durable
 * machinery: per-module views plus host-level facts (pending timers,
 * active/recovered fibers). The shape of each view is module-owned.
 */
export type DiagnosticBundle = {
  generatedAt: number;
  /** One entry per registered inspector namespace. */
  views: Record<string, unknown>;
};

/**
 * Read-only per-object forensics. Modules register inspectors for their
 * own state; the host aggregates them into one bundle. This — not the
 * backing tables — is the supported way to look inside an agent.
 */
export interface DiagnosticsHost {
  registerInspector(namespace: string, fn: () => Promise<unknown>): Disposable;
  diagnostics(opts?: { scrub?: boolean }): Promise<DiagnosticBundle>;
}

/**
 * The full kernel. Modules should declare the narrowest slice they
 * actually need (e.g. `SqlHost & TimerHost`), not this union.
 *
 * The KV capability is exposed as a `kv` property rather than flat
 * methods: generic names like `get`/`delete` would pollute the `Agent`
 * public API and collide with userland subclass methods.
 */
export type AgentHost = SqlHost &
  TimerHost &
  LifetimeHost &
  FiberHost &
  EventHost &
  DiagnosticsHost & { readonly kv: KvHost } & Partial<ConnectionHost>;
