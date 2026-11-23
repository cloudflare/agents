/**
 * Lifecycle background-work vocabulary. Queue validates items, resolves
 * named callbacks, and pushes jobs due immediately into the Lifecycle-owned
 * job queue; Lifecycle runs the alarm event loop, retry policy, and physical
 * alarm arming. Queue owns no storage of its own — each item is one job
 * whose `fn` is the callback name and whose payload carries the item's
 * payload. In a sub-agent the items live in the sub-agent's own job queue,
 * which its root wakes.
 */

import {
  LifecycleCapability,
  type LifecycleRouteContext
} from "../lifecycle/capability";
import type {
  LifecycleJob,
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../lifecycle/job-queue";
import {
  isPlatformFailure,
  resolveRetryConfig,
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

/**
 * What a Queue job's payload carries: the item payload. Items a root held
 * for a sub-agent before sub-agents kept their own queue also carry the
 * sub-agent's path; the root hands those over when they come due.
 */
type QueueJobPayload = {
  readonly payload?: unknown;
  readonly owner_path?: string | null;
  readonly owner_path_key?: string | null;
};

/** A root handing an item it held for a sub-agent to that sub-agent. */
type QueueAdoptMessage = {
  readonly type: "adopt";
  readonly item: QueueItem<unknown>;
};

function isQueueJobPayload(value: unknown): value is QueueJobPayload {
  // `payload` is absent after a JSON round trip when the item carried none.
  return typeof value === "object" && value !== null;
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
   * in due-time order, so pushes get strictly increasing times to keep push
   * order (FIFO) even within one millisecond. Seeded from the persisted
   * queue tail on first use so a fresh instance never sorts a new item ahead
   * of items an earlier instance already queued.
   */
  #lastTime: number | null = null;

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
   *
   * TEMPORARY: one-shot upgrade path for objects that had queued items when
   * this release landed. Remove in the next minor release (with the schema
   * version bump that gates it), once every deployed object has migrated.
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
        payload: { payload } satisfies QueueJobPayload,
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

    if (job.payload.owner_path) return this.#handOver(job, item);

    const handler = this.#resolveCallback(job.fn);
    if (!handler) {
      console.error(`callback ${job.fn} not found`);
      return undefined;
    }
    await this.lifecycle.runInHostContext(() => handler(item.payload, item));
    return undefined;
  }

  /**
   * Observe one item's terminal failure; the item is dropped. That includes
   * an item whose attempts all ended with their isolate
   * (`JobAttemptsExhaustedError`), whatever reset the isolate: dropping it
   * is what stops an item that keeps killing the isolate from running
   * forever, and the Lifecycle allows at least three such attempts first.
   */
  async onJobError(
    context: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome | void> {
    const { job, attempt } = context;
    console.error(
      `queue callback "${job.fn}" failed after ${attempt} attempts`,
      error
    );
    this.#emit("queue:error", {
      callback: job.fn,
      id: job.id,
      error: error instanceof Error ? error.message : String(error),
      attempts: attempt
    });
    try {
      await this.#onError?.(error);
    } catch {
      // swallow onError errors
    }
    return undefined;
  }

  /**
   * TEMPORARY, for items a root held for a sub-agent before this release:
   * when one comes due, the root hands it to the sub-agent's own queue and
   * drops its copy. A path that is gone drops the item. Remove with the
   * next minor release.
   */
  async #handOver(
    job: LifecycleJob,
    item: QueueItem<unknown>
  ): Promise<LifecycleJobOutcome | void> {
    const path = job.payload as QueueJobPayload;
    try {
      await this.lifecycle.routes.to(
        {
          key: path.owner_path_key ?? path.owner_path!,
          data: path.owner_path!
        },
        { type: "adopt", item } satisfies QueueAdoptMessage
      );
    } catch (error) {
      // Keep the item for a later alarm; platform failures go to the
      // driver's own handling.
      if (isPlatformFailure(error)) throw error;
      console.error(`error handing queue item "${job.id}" over`, error);
      return "yield";
    }
    return undefined;
  }

  /** In a sub-agent: take over an item its root held for it. */
  async onRoute(context: LifecycleRouteContext): Promise<unknown> {
    const message = context.payload as QueueAdoptMessage;
    if (message.type !== "adopt") {
      throw new Error("Unknown routed Queue message");
    }
    const { item } = message;
    if (this.lifecycle.jobs.get(item.id)) return true;
    await this.lifecycle.jobs.push({
      id: item.id,
      fn: item.callback,
      time: this.#nextTime(),
      payload: { payload: item.payload } satisfies QueueJobPayload,
      retry: resolveRetryConfig(item.retry, this.#retryDefaults)
    });
    return true;
  }

  // ── Queue API ────────────────────────────────────────────────────────────

  /**
   * Push one item for a registered callback. The item is due immediately;
   * the Lifecycle alarm event loop runs it in push order after this call
   * returns.
   *
   * Once the Lifecycle has started, the item row is written synchronously before this
   * method's promise is even returned, so a caller may pair a push with its
   * own writes in one synchronous block — the item then commits atomically
   * with them.
   */
  async push<Name extends keyof Handlers & string>(
    callback: Name,
    payload?: QueuePayload<Handlers[Name]>,
    options?: QueuePushOptions
  ): Promise<QueueItem<QueuePayload<Handlers[Name]>>> {
    if (this.lifecycle.status() !== "started") await this.lifecycle.ready();
    this.#validatePush(callback, options);
    const item = await this.#insert<QueuePayload<Handlers[Name]>>(
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
    if (!this.#get(id)) return false;
    return this.lifecycle.jobs.cancel(id);
  }

  /** Cancel every pending item, or every item for one callback. Returns the count. */
  async cancelAll(callback?: string): Promise<number> {
    await this.lifecycle.ready();
    let cancelled = 0;
    for (const item of this.#list({ callback })) {
      if (await this.lifecycle.jobs.cancel(item.id)) cancelled++;
    }
    return cancelled;
  }

  /** Read one pending item. */
  async get<T = unknown>(id: string): Promise<QueueItem<T> | undefined> {
    await this.lifecycle.ready();
    return this.#get<T>(id);
  }

  /** List pending items in push order, optionally filtered by callback. */
  async list<T = unknown>(criteria?: QueueCriteria): Promise<QueueItem<T>[]> {
    await this.lifecycle.ready();
    return this.#list<T>(criteria);
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
    if (this.#lastTime === null) {
      this.#lastTime = this.#ownedJobs().reduce(
        (lastTime, { job }) => Math.max(lastTime, job.time),
        0
      );
    }
    const time = Math.max(Date.now(), this.#lastTime + 1);
    this.#lastTime = time;
    return time;
  }

  async #insert<T>(
    callback: string,
    payload: unknown,
    options?: QueuePushOptions
  ): Promise<QueueItem<T>> {
    // A stable-id push replaces the item in place: it keeps the existing
    // item's due time, and so its position in the queue.
    const existing =
      options?.id !== undefined
        ? this.lifecycle.jobs.get(options.id)
        : undefined;
    const keepTime = existing !== undefined;
    const job = await this.lifecycle.jobs.push({
      id: options?.id,
      fn: callback,
      time: keepTime ? existing.time : this.#nextTime(),
      payload: { payload } satisfies QueueJobPayload,
      retry: resolveRetryConfig(options?.retry, this.#retryDefaults)
    });
    return this.#jobToItem<T>(job, job.payload as QueueJobPayload);
  }

  #jobToItem<T>(job: LifecycleJob, envelope: QueueJobPayload): QueueItem<T> {
    return {
      id: job.id,
      callback: job.fn,
      payload: envelope.payload as T,
      createdAt: job.createdAt,
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

  /** One item this Queue holds for itself (not one held for a sub-agent). */
  #get<T>(id: string): QueueItem<T> | undefined {
    const job = this.lifecycle.jobs.get(id);
    if (!job || !isQueueJobPayload(job.payload)) return undefined;
    if (job.payload.owner_path) return undefined;
    return this.#jobToItem<T>(job, job.payload);
  }

  #list<T>(criteria: QueueCriteria = {}): QueueItem<T>[] {
    const items: QueueItem<T>[] = [];
    for (const { job, envelope } of this.#ownedJobs()) {
      if (envelope.owner_path) continue;
      if (criteria.callback && job.fn !== criteria.callback) continue;
      items.push(this.#jobToItem<T>(job, envelope));
    }
    return items;
  }

  // ── Events ───────────────────────────────────────────────────────────────

  #emit(type: QueueEventType, payload: Record<string, unknown>): void {
    this.lifecycle.events.emit(type, payload);
  }
}
