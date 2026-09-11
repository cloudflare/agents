/**
 * Lifecycle background-work vocabulary. Queue validates items, resolves
 * named callbacks, and pushes jobs due immediately into the Lifecycle-owned
 * job queue; Lifecycle runs the alarm event loop, retry policy, and physical
 * alarm arming. Queue owns no storage of its own — each item is one job
 * whose `fn` is the callback name and whose payload carries the item's
 * payload and owner.
 */

import {
  LifecycleCapability,
  type LifecycleRouteAddress,
  type LifecycleRouteContext
} from "../lifecycle/capability";
import type {
  LifecycleJob,
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../lifecycle/job-queue";
import {
  isDurableObjectCodeUpdateReset,
  isPlatformFailure,
  tryN,
  validateRetryOptions
} from "../retries";
import type { RetryOptions } from "../retries";
import type { QueueEventType, QueueOptions } from "./options";
import type {
  QueueCallbacks,
  QueueCriteria,
  QueueHandlers,
  QueueItem,
  QueuePayload,
  QueuePushOptions,
  QueueStorageRow
} from "./types";

/** A resolved fallback handler for a callback name outside the registered map. */
type ResolvedQueueCallback = (
  payload: unknown,
  item: QueueItem<unknown>
) => unknown;

const queueCallbackResolvers = new WeakMap<
  object,
  (name: string) => ResolvedQueueCallback | undefined
>();

/**
 * @internal Supply a composition-root fallback for callback names outside the
 * registered map. Agent uses this to keep its historical name-based queue
 * API (`this.queue("methodName", payload)`) working: the resolver looks the
 * method up on the Agent, and the resolved handler still runs inside the
 * Lifecycle host boundary.
 */
export function setQueueCallbackResolver(
  queue: Queue<never>,
  resolver: (name: string) => ResolvedQueueCallback | undefined
): void {
  queueCallbackResolvers.set(queue, resolver);
}

const QUEUE_SCHEMA_VERSION_KEY = "cf_agents:queue_schema_version";
/** Version 1: queue items live in the Lifecycle job queue. */
const CURRENT_QUEUE_SCHEMA_VERSION = 1;

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 3000
};

/** What a Queue job's payload carries: the item payload and its owner. */
type QueueJobPayload = {
  readonly payload: unknown;
  readonly owner_path: string | null;
  readonly owner_path_key: string | null;
};

type QueueRouteMessage =
  | {
      readonly type: "push";
      readonly callback: string;
      readonly payload: unknown;
      readonly options?: QueuePushOptions;
    }
  | { readonly type: "get" | "cancel"; readonly id: string }
  | { readonly type: "list"; readonly criteria?: QueueCriteria }
  | { readonly type: "cancelAll"; readonly callback?: string }
  | {
      readonly type: "dispatch";
      readonly item: QueueItem<unknown>;
    };

function resolveRetryConfig(
  retry: RetryOptions | undefined,
  defaults: Required<RetryOptions>
): Required<RetryOptions> {
  return {
    maxAttempts: retry?.maxAttempts ?? defaults.maxAttempts,
    baseDelayMs: retry?.baseDelayMs ?? defaults.baseDelayMs,
    maxDelayMs: retry?.maxDelayMs ?? defaults.maxDelayMs
  };
}

function isQueueJobPayload(value: unknown): value is QueueJobPayload {
  // `payload` is absent after a JSON round trip when the item carried none.
  return typeof value === "object" && value !== null && "owner_path" in value;
}

/**
 * Durable background work for a Lifecycle Object.
 *
 * Register callbacks in the constructor and install the instance with
 * `Lifecycle.use()`. Each pushed item becomes a job due immediately in the
 * Lifecycle job queue; Lifecycle owns the physical alarm and the alarm event
 * loop, drives items one at a time in push order, retries a throwing
 * callback per its retry policy, and Queue runs registered callbacks through
 * Lifecycle's host invocation boundary. An item that still fails after its
 * last attempt is dropped after `queue:error` and the `onError` hook.
 *
 * Items survive the Durable Object leaving memory: an isolate that dies mid
 * callback wakes again on the Lifecycle deadman alarm and resumes the queue.
 * Callbacks should therefore be idempotent.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Queue<
  Handlers extends QueueHandlers = QueueCallbacks
> extends LifecycleCapability {
  readonly #handlers: QueueHandlers;
  readonly #retryDefaults: Required<RetryOptions>;
  readonly #onError: ((error: unknown) => void | Promise<void>) | undefined;
  /**
   * Last due time handed to a job. The Lifecycle driver dispatches due jobs
   * in due-time order, so pushes made within the same millisecond get
   * strictly increasing times to keep push order (FIFO) among them.
   */
  #lastTime = 0;

  /**
   * Create a durable Queue.
   *
   * @param options - Registered callbacks plus optional retry and error
   * policy. Registering `callbacks` types {@link push} against the map —
   * names and payloads are checked where the handlers are declared and where
   * they are pushed. Names outside the map are rejected unless a
   * composition-root resolver supplies them — the internal aperture behind
   * `Agent`'s name-based queue API.
   */
  constructor(options: QueueOptions<Handlers> = {}) {
    super("queue");
    this.#handlers = options.callbacks ?? {};
    // Retry defaults are resolved, not validated, here: invalid defaults
    // surface per execution as queue:error instead of bricking the object at
    // construction. Per-item retry overrides are validated when pushed.
    this.#retryDefaults = resolveRetryConfig(options.retry, DEFAULT_RETRY);
    this.#onError = options.onError;
  }

  // ── Lifecycle capability hooks ───────────────────────────────────────────

  /** Migrate legacy `cf_agents_queues` rows into the Lifecycle job queue. */
  async onStart(): Promise<void> {
    const storage = this.lifecycle.storage;
    const version = (await storage.get<number>(QUEUE_SCHEMA_VERSION_KEY)) ?? 0;
    if (version >= CURRENT_QUEUE_SCHEMA_VERSION) return;

    await this.#migrateLegacyQueueTable(storage);
    await storage.put(QUEUE_SCHEMA_VERSION_KEY, CURRENT_QUEUE_SCHEMA_VERSION);
  }

  /**
   * Move every `cf_agents_queues` row into the job queue and drop the
   * table. Idempotent: a missing table means a fresh object or a completed
   * migration. Rows keep their insertion order.
   */
  async #migrateLegacyQueueTable(storage: DurableObjectStorage): Promise<void> {
    const tables = storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cf_agents_queues'"
      )
      .toArray();
    if (tables.length === 0) return;

    const rows = storage.sql
      .exec("SELECT * FROM cf_agents_queues ORDER BY created_at ASC, rowid ASC")
      .toArray() as unknown as QueueStorageRow[];
    for (const row of rows) {
      let payload: unknown;
      try {
        payload =
          typeof row.payload === "string" ? JSON.parse(row.payload) : undefined;
      } catch (error) {
        console.error(
          `Skipping queue item "${row.id}" during job-queue migration: ` +
            "its payload is not valid JSON",
          error
        );
        continue;
      }
      let retry: RetryOptions | undefined;
      try {
        retry =
          typeof row.retry_options === "string"
            ? (JSON.parse(row.retry_options) as RetryOptions)
            : undefined;
      } catch {
        retry = undefined;
      }
      await this.lifecycle.jobs.push({
        id: row.id,
        fn: row.callback,
        time: this.#nextTime(),
        payload: {
          payload,
          owner_path: null,
          owner_path_key: null
        } satisfies QueueJobPayload,
        retry: resolveRetryConfig(retry, this.#retryDefaults)
      });
    }
    storage.sql.exec("DROP TABLE cf_agents_queues");
  }

  /** Drive one due item dispatched by the Lifecycle event loop. */
  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    const { job, attempt } = context;
    if (!isQueueJobPayload(job.payload)) {
      console.error(`Malformed queue item ${job.id}; dropping it`);
      return undefined;
    }
    const item = this.#jobToItem(job, job.payload);

    if (attempt > 1) {
      this.#emit("queue:retry", {
        callback: job.fn,
        id: job.id,
        attempt,
        maxAttempts: resolveRetryConfig(job.retry, this.#retryDefaults)
          .maxAttempts
      });
    }

    if (job.payload.owner_path) {
      // A routed item executes inside its owning Lifecycle; retries run
      // there too, so this dispatch is a single routed attempt.
      try {
        await this.lifecycle.routes.to(
          {
            key: job.payload.owner_path_key ?? job.payload.owner_path,
            data: job.payload.owner_path
          },
          { type: "dispatch", item } satisfies QueueRouteMessage
        );
      } catch (error) {
        if (isPlatformFailure(error)) {
          // Preserve the item; Lifecycle defers platform-class failures to
          // a fresh invocation or the memory-limit breaker.
          throw error;
        }
        console.error(`error dispatching queue callback "${job.fn}"`, error);
        this.#emit("queue:error", {
          callback: job.fn,
          id: job.id,
          error: error instanceof Error ? error.message : String(error),
          attempts: 0
        });
        try {
          await this.#onError?.(error);
        } catch {
          // swallow onError errors
        }
        // Leave the item due so a later alarm cycle can retry dispatch, for
        // example once a transport can resolve its owner again.
        return "yield";
      }
      return undefined;
    }

    const handler = this.#resolveCallback(job.fn);
    if (!handler) {
      console.error(`callback ${job.fn} not found`);
      return undefined;
    }
    await this.lifecycle.runInHostContext(() => handler(item.payload, item));
    return undefined;
  }

  /** Observe one item's terminal application failure; the item is dropped. */
  async onJobError(
    context: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome | void> {
    const { job } = context;
    const { maxAttempts } = resolveRetryConfig(job.retry, this.#retryDefaults);
    console.error(
      `queue callback "${job.fn}" failed after ${maxAttempts} attempts`,
      error
    );
    this.#emit("queue:error", {
      callback: job.fn,
      id: job.id,
      error: error instanceof Error ? error.message : String(error),
      attempts: maxAttempts
    });
    try {
      await this.#onError?.(error);
    } catch {
      // swallow onError errors
    }
    return undefined;
  }

  /** Handle Queue protocol messages routed by another Lifecycle. */
  async onRoute(context: LifecycleRouteContext): Promise<unknown> {
    const message = context.payload as QueueRouteMessage;
    const owner = context.source ?? null;
    switch (message.type) {
      case "push":
        return this.#insert(
          owner,
          message.callback,
          message.payload,
          message.options
        );
      case "get":
        return this.#getForOwner(owner, message.id);
      case "list":
        return this.#listForOwner(owner, message.criteria);
      case "cancel":
        return this.#cancelForOwner(owner, message.id);
      case "cancelAll":
        return this.#cancelAllForOwner(owner, message.callback);
      case "dispatch":
        await this.#executeRouted(message.item);
        return true;
      default:
        throw new Error("Unknown routed Queue message");
    }
  }

  /**
   * Execute a routed item locally with the historical retry handling. Runs
   * on the owning (facet) Queue, outside the root's event loop, so it applies
   * its own in-process retry budget. Platform-class failures re-throw so the
   * root preserves the item and the durable alarm retries on a fresh
   * invocation.
   */
  async #executeRouted(item: QueueItem<unknown>): Promise<void> {
    const handler = this.#resolveCallback(item.callback);
    if (!handler) {
      console.error(`callback ${item.callback} not found`);
      return;
    }
    const { maxAttempts, baseDelayMs, maxDelayMs } = resolveRetryConfig(
      item.retry,
      this.#retryDefaults
    );
    try {
      await tryN(
        maxAttempts,
        async (attempt) => {
          if (attempt > 1) {
            this.#emit("queue:retry", {
              callback: item.callback,
              id: item.id,
              attempt,
              maxAttempts
            });
          }
          await this.lifecycle.runInHostContext(() =>
            handler(item.payload, item)
          );
        },
        {
          baseDelayMs,
          maxDelayMs,
          shouldRetry: (error) => !isDurableObjectCodeUpdateReset(error)
        }
      );
    } catch (error) {
      if (isPlatformFailure(error)) {
        throw error;
      }
      console.error(
        `queue callback "${item.callback}" failed after ${maxAttempts} attempts`,
        error
      );
      this.#emit("queue:error", {
        callback: item.callback,
        id: item.id,
        error: error instanceof Error ? error.message : String(error),
        attempts: maxAttempts
      });
      try {
        await this.#onError?.(error);
      } catch {
        // swallow onError errors
      }
    }
  }

  // ── Queue API ────────────────────────────────────────────────────────────

  /**
   * Push one item for a registered callback. The item is due immediately;
   * the Lifecycle alarm event loop runs it in push order after this call
   * returns.
   *
   * Once the Lifecycle has started (and this Queue is not routed through
   * another Lifecycle), the item row is written synchronously before this
   * method's promise is even returned, so a caller may pair a push with its
   * own writes in one synchronous block — the item then commits atomically
   * with them.
   */
  async push<Name extends keyof Handlers & string>(
    callback: Name,
    payload?: QueuePayload<Handlers[Name]>,
    options?: QueuePushOptions
  ): Promise<QueueItem<QueuePayload<Handlers[Name]>>> {
    if (!this.lifecycle.started()) await this.lifecycle.ready();
    this.#validatePush(callback, options);
    const item = this.lifecycle.routes.source
      ? ((await this.lifecycle.routes.toRoot({
          type: "push",
          callback,
          payload,
          options
        } satisfies QueueRouteMessage)) as QueueItem<
          QueuePayload<Handlers[Name]>
        >)
      : await this.#insert<QueuePayload<Handlers[Name]>>(
          null,
          callback,
          payload,
          options
        );
    this.#emit("queue:create", { callback, id: item.id });
    return item;
  }

  /** Cancel one pending item. Returns false when no item matched. */
  async cancel(id: string): Promise<boolean> {
    await this.lifecycle.ready();
    if (this.lifecycle.routes.source) {
      return (await this.lifecycle.routes.toRoot({
        type: "cancel",
        id
      } satisfies QueueRouteMessage)) as boolean;
    }
    return this.#cancelForOwner(null, id);
  }

  /** Cancel every pending item, or every item for one callback. Returns the count. */
  async cancelAll(callback?: string): Promise<number> {
    await this.lifecycle.ready();
    if (this.lifecycle.routes.source) {
      return (await this.lifecycle.routes.toRoot({
        type: "cancelAll",
        callback
      } satisfies QueueRouteMessage)) as number;
    }
    return this.#cancelAllForOwner(null, callback);
  }

  /** Read one pending item. */
  async get<T = unknown>(id: string): Promise<QueueItem<T> | undefined> {
    await this.lifecycle.ready();
    if (this.lifecycle.routes.source) {
      return (await this.lifecycle.routes.toRoot({
        type: "get",
        id
      } satisfies QueueRouteMessage)) as QueueItem<T> | undefined;
    }
    return this.#getForOwner<T>(null, id);
  }

  /** List pending items in push order, optionally filtered by callback. */
  async list<T = unknown>(criteria?: QueueCriteria): Promise<QueueItem<T>[]> {
    await this.lifecycle.ready();
    if (this.lifecycle.routes.source) {
      return (await this.lifecycle.routes.toRoot({
        type: "list",
        criteria
      } satisfies QueueRouteMessage)) as QueueItem<T>[];
    }
    return this.#listForOwner<T>(null, criteria);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  #validatePush(callback: string, options?: QueuePushOptions): void {
    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }
    if (!this.#hasCallback(callback)) {
      throw new Error(
        `Unknown queue callback "${callback}": not registered on this Queue`
      );
    }
    if (options?.retry)
      validateRetryOptions(options.retry, this.#retryDefaults);
    if (options?.id !== undefined && options.id.trim() === "") {
      throw new Error("Queue item ids must be non-empty");
    }
  }

  /** Resolve a name to its registered or composition-root-supplied handler. */
  #resolveCallback(name: string): ResolvedQueueCallback | undefined {
    const handler = this.#handlers[name];
    if (handler) {
      // SAFETY: registered handlers are constrained with `never` parameters
      // so concrete handler types satisfy the map under contravariance; the
      // payload passed at dispatch was persisted with this handler's name.
      return handler as ResolvedQueueCallback;
    }
    return queueCallbackResolvers.get(this)?.(name);
  }

  #hasCallback(name: string): boolean {
    return this.#resolveCallback(name) !== undefined;
  }

  /** The next strictly increasing due time, never before now. */
  #nextTime(): number {
    const time = Math.max(Date.now(), this.#lastTime + 1);
    this.#lastTime = time;
    return time;
  }

  async #insert<T>(
    owner: LifecycleRouteAddress | null,
    callback: string,
    payload: unknown,
    options?: QueuePushOptions
  ): Promise<QueueItem<T>> {
    const job = await this.lifecycle.jobs.push({
      id: options?.id,
      fn: callback,
      time: this.#nextTime(),
      payload: {
        payload,
        owner_path: owner?.data ?? null,
        owner_path_key: owner?.key ?? null
      } satisfies QueueJobPayload,
      retry: resolveRetryConfig(options?.retry, this.#retryDefaults)
    });
    return this.#jobToItem<T>(job, job.payload as QueueJobPayload);
  }

  #jobToItem<T>(job: LifecycleJob, envelope: QueueJobPayload): QueueItem<T> {
    return {
      id: job.id,
      callback: job.fn,
      payload: envelope.payload as T,
      created_at: job.createdAt,
      retry: job.retry
    };
  }

  /** Every queue job this Queue owns, in push order. */
  #ownedJobs(): Array<{ job: LifecycleJob; envelope: QueueJobPayload }> {
    const owned: Array<{ job: LifecycleJob; envelope: QueueJobPayload }> = [];
    for (const job of this.lifecycle.jobs.list()) {
      if (isQueueJobPayload(job.payload)) {
        owned.push({ job, envelope: job.payload });
      }
    }
    return owned;
  }

  #getForOwner<T>(
    owner: LifecycleRouteAddress | null,
    id: string
  ): QueueItem<T> | undefined {
    const ownerKey = owner?.key ?? null;
    const job = this.lifecycle.jobs.get(id);
    if (!job || !isQueueJobPayload(job.payload)) return undefined;
    if ((job.payload.owner_path_key ?? null) !== ownerKey) return undefined;
    return this.#jobToItem<T>(job, job.payload);
  }

  #listForOwner<T>(
    owner: LifecycleRouteAddress | null,
    criteria: QueueCriteria = {}
  ): QueueItem<T>[] {
    const ownerKey = owner?.key ?? null;
    const items: QueueItem<T>[] = [];
    for (const { job, envelope } of this.#ownedJobs()) {
      if ((envelope.owner_path_key ?? null) !== ownerKey) continue;
      if (criteria.callback && job.fn !== criteria.callback) continue;
      items.push(this.#jobToItem<T>(job, envelope));
    }
    return items;
  }

  async #cancelForOwner(
    owner: LifecycleRouteAddress | null,
    id: string
  ): Promise<boolean> {
    if (!this.#getForOwner(owner, id)) return false;
    return this.lifecycle.jobs.cancel(id);
  }

  async #cancelAllForOwner(
    owner: LifecycleRouteAddress | null,
    callback?: string
  ): Promise<number> {
    let cancelled = 0;
    for (const item of this.#listForOwner(owner, { callback })) {
      if (await this.lifecycle.jobs.cancel(item.id)) cancelled++;
    }
    return cancelled;
  }

  // ── Events ───────────────────────────────────────────────────────────────

  #emit(type: QueueEventType, payload: Record<string, unknown>): void {
    this.lifecycle.events.emit(type, payload);
  }
}
