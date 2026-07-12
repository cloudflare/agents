# 06 — Fibers: durable execution

Original: `runFiber` / `startFiber` / `stash` / `onFiberRecovered` +
inspect/cancel/resolve/delete APIs on `Agent`, backed by `cf_agents_runs`
(transient run rows) and a managed-fiber ledger. This is the foundation for
chat recovery (doc 14) and webhook-idempotent side effects.

## Concepts

- **Fiber**: a named async closure executed now, registered durably *before*
  it runs, so an eviction mid-run leaves a row that triggers recovery on next
  activation.
- **Checkpoint (`stash`)**: synchronous full-replacement snapshot persisted
  with the run row. The closure itself cannot be persisted — recovery gets
  only `{ name, snapshot, metadata }` and decides what resuming means.
- **Plain fiber** (`run`): transient row; deleted on completion or error;
  caller gets the return value.
- **Managed fiber** (`start`): additionally writes a retained ledger row with
  status + idempotency key. Duplicate `start` with the same key returns the
  retained status (`accepted: false`) instead of re-running; concurrent
  duplicates join the in-flight execution when `waitForCompletion`.

## Statuses (managed ledger)
`pending → running → completed | error | aborted | interrupted`

## Behaviors to preserve

1. Row is inserted **before** the closure runs; keep-alive is held for the
   duration; row deleted (plain) / settled (managed) afterward.
2. `stash(data)` fully replaces the snapshot, synchronously. Also expose a
   context-free `stash` via an ambient current-fiber mechanism
   (AsyncLocalStorage in the original; rebuild: an explicit async-context
   holder in the fibers module — `currentFiber()` — is acceptable) that throws
   outside a fiber.
3. Errors: closure throw → plain fiber deletes row and rethrows (or logs when
   fire-and-forget); managed fiber settles `error` with the message. **No
   automatic retries.**
4. Cancellation is cooperative: `cancel(fiberId, reason)` aborts the fiber's
   `AbortSignal` if running in this process and settles the managed row
   `aborted`. `waitForCompletion` callers resolve when the ledger settles even
   if a non-cooperative closure is still running.
5. Recovery scan (`checkInterrupted()`), invoked on startup and from an
   internal housekeeping schedule:
   - Every orphaned run row (no live execution in this process) →
     mark managed ledger `interrupted`, emit `fiber:run:interrupted` +
     `fiber:recovery:detected`, call the host's `onRecovered(ctx)` hook
     (`ctx = { id, name, snapshot, metadata, idempotencyKey?, createdAt, recoveryReason: "interrupted" }`).
   - Hook returns `FiberRecoveryResult` (`{ status: "completed"|"error"|..., snapshot? }`)
     → settle the managed row accordingly; returns undefined → managed row
     stays `interrupted`; plain fiber rows are deleted after the hook returns.
   - Hook **throws** → keep the row for a later scan, retried on exponential
     backoff capped at 5 minutes (via an internal schedule), until the row is
     older than `recoveryMaxAgeMs` (default 24h) → discard with
     `fiber:recovery:skipped` (`reason: "max_age_exceeded"`). `recoveryMaxAgeMs: 0`
     = retry forever.
6. `resolveFiber(id, result)` updates **only** `interrupted` managed rows
   (returns false otherwise) — for app-level recovery driven by, say, a
   duplicate webhook.
7. `deleteFibers({ status?, settledBefore? })` defaults to settled
   `completed|error|aborted` rows; never deletes `interrupted` unless that
   status is passed explicitly.
8. Events: `fiber:run:started|completed|failed|interrupted`,
   `fiber:recovery:detected|attempt|handled|skipped|failed` with
   `{ fiberId, fiberName, managed?, elapsedMs?, ... }` payloads.

## Proposed interface

```ts
export interface FiberContext {
  id: string;
  signal: AbortSignal;
  stash(data: unknown): void;
  snapshot: unknown | null;
}
export type FiberStatus = "pending" | "running" | "completed" | "error" | "aborted" | "interrupted";
export interface FiberInspection {
  fiberId: string; name: string; status: FiberStatus;
  idempotencyKey?: string; metadata?: Record<string, unknown> | null;
  snapshot: unknown | null; error?: string;
  createdAt: number; settledAt?: number;
}
export interface FiberRecoveryContext extends Omit<FiberInspection, "status"> {
  status?: FiberStatus; recoveryReason: "interrupted";
}
export type FiberRecoveryResult = { status: "completed" | "error" | "aborted"; error?: string; snapshot?: unknown };

export interface FiberService {
  run<T>(name: string, fn: (ctx: FiberContext) => Promise<T>): Promise<T>;
  start(name: string, fn: (ctx: FiberContext) => Promise<void>, options?: {
    idempotencyKey?: string; metadata?: Record<string, unknown>;
    waitForCompletion?: boolean;
  }): Promise<{ fiberId: string; accepted: boolean; status: FiberStatus; error?: string }>;
  stash(data: unknown): void;                       // ambient; throws outside a fiber
  inspect(fiberId: string): FiberInspection | null;
  inspectByKey(idempotencyKey: string): FiberInspection | null;
  list(options?: { status?: FiberStatus[]; name?: string }): FiberInspection[];
  cancel(fiberId: string, reason?: string): boolean;
  cancelByKey(idempotencyKey: string, reason?: string): boolean;
  resolve(fiberId: string, result: FiberRecoveryResult): boolean;
  deleteFibers(options?: { status?: FiberStatus[]; settledBefore?: number }): number;
  /** Recovery scan; call on startup + housekeeping alarm. */
  checkInterrupted(): Promise<void>;
}
export function createFiberService(deps: {
  store: KeyValueStore;          // prefixes "fiber:run:" (transient) and "fiber:ledger:"
  clock: Clock; ids: IdSource; bus: EventBus;
  keepAlive: KeepAlive;
  scheduler: Scheduler;          // for recovery backoff + housekeeping registration
  onRecovered: (ctx: FiberRecoveryContext) => Promise<void | FiberRecoveryResult>;
  recoveryMaxAgeMs?: number;     // default 86_400_000; 0 = forever
}): FiberService;
```

Sub-agent note (for docs 19/22): in the original, facets have no alarm slot, so
the parent keeps a root-side index of child fibers and routes recovery into the
child. In the rebuild, each agent instance owns a FiberService over its own
scoped store; the delegation module (doc 19) handles parent-driven
reconciliation of child runs. Root-side fiber indexing is explicitly simplified
away — the in-memory spawner keeps children alive; a future Cloudflare adapter
would reintroduce routing.

## Tests (TDD list)
- run: happy path returns value, row lifecycle, keep-alive held during run.
- stash sync persistence; ambient stash inside/outside fiber.
- start: idempotent duplicate returns accepted:false with same fiberId;
  waitForCompletion joins in-flight run; error settles ledger.
- cancel: signal aborts; ledger aborted; waiter resolves.
- recovery: orphan row (write rows via a first service instance, "evict" by
  creating a second instance without running closures) → onRecovered called
  with snapshot; result settles row; throwing hook retries with backoff and
  respects max age; resolve() only on interrupted; deleteFibers defaults.
