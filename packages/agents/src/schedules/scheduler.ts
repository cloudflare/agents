/**
 * Lifecycle scheduling vocabulary. Scheduler validates schedules, resolves
 * named callbacks, and pushes jobs into the Lifecycle-owned job queue;
 * Lifecycle runs the alarm event loop, retry policy, and physical alarm
 * arming. Scheduler owns no storage of its own — each schedule is one job
 * whose `fn` is the callback name and whose payload carries the schedule's
 * timing vocabulary.
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
import {
  DeclaredScheduleSet,
  isDeclaredJob,
  type DeclaredScheduleInfo,
  type DeclaredSchedulesSource,
  type DeclareSchedulesOptions
} from "./declared";
import type { SchedulerEventType, SchedulerOptions } from "./options";
import {
  isRecurring,
  nextCronTimeMs,
  parseInterval,
  parseWhen,
  validateIntervalSeconds,
  type ScheduleTiming
} from "./schedule-timing";
import type {
  RecoveryLoopScheduleOptions,
  Schedule,
  ScheduleCriteria,
  ScheduleOptions,
  ScheduleStorageRow,
  SchedulerCallbacks,
  SchedulerHandlers,
  SchedulerPayload
} from "./types";

/**
 * A resolved fallback handler for a callback name outside the registered map.
 */
type ResolvedSchedulerCallback = (
  payload: unknown,
  schedule: Schedule<unknown>
) => unknown;

const schedulerCallbackResolvers = new WeakMap<
  object,
  (name: string) => ResolvedSchedulerCallback | undefined
>();

/**
 * @internal Supply a composition-root fallback for callback names outside the
 * registered map. Agent uses this to keep its historical name-based
 * scheduling API (`this.schedule(60, "methodName")`) working: the resolver
 * looks the method up on the Agent, and the resolved handler still runs
 * inside the Lifecycle host boundary.
 */
export function setSchedulerCallbackResolver(
  scheduler: Scheduler<never>,
  resolver: (name: string) => ResolvedSchedulerCallback | undefined
): void {
  schedulerCallbackResolvers.set(scheduler, resolver);
}

const SCHEDULE_SCHEMA_VERSION_KEY = "cf_agents:schedules_schema_version";
/**
 * Version 2: schedule rows live in the Lifecycle job queue.
 * Version 3: Think's declared-task rows became declared-schedule jobs.
 */
const CURRENT_SCHEDULE_SCHEMA_VERSION = 3;

/**
 * Legacy schedule callbacks whose rows drive chat recovery loops from before
 * the job queue carried breaker membership. The migration is the one place
 * allowed to know legacy names (it already drops `_cf_keepAliveHeartbeat`
 * rows by name): a recovery row migrated without its `recoveryLoop` flag
 * would escape the alarm memory-limit breaker (#1825) and could re-trigger
 * a doomed loop on an upgraded object.
 */
const LEGACY_RECOVERY_LOOP_CALLBACKS = new Set([
  "_chatRecoveryContinue",
  "_chatRecoveryRetry"
]);

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 3000
};

/**
 * The schedule timing vocabulary carried in one job's payload. The callback
 * name is the job's `fn`; the user payload rides in `payload`.
 */
type SchedulerJobPayload = {
  readonly payload: unknown;
  readonly type: "scheduled" | "delayed" | "cron" | "interval";
  /** The caller-supplied retry override, unresolved, for public projection.
      The job's own retry options are fully resolved against the Scheduler
      defaults at push so the Lifecycle driver applies the configured
      policy. */
  readonly retry?: RetryOptions;
  readonly delayInSeconds?: number;
  readonly cron?: string;
  readonly intervalSeconds?: number;
  /** Set only on schedules a root held for a sub-agent before sub-agents
      kept their own; the root hands those over on its first alarm after
      the upgrade. TEMPORARY, with the fields below. */
  readonly owner_path?: string | null;
  readonly owner_path_key?: string | null;
  /** A held schedule's own due time while it waits to be handed over. */
  readonly handover_time?: number;
  /** In a sub-agent: a schedule its root handed over. */
  readonly adopted?: true;
};

/** A root handing a schedule it held for a sub-agent to that sub-agent. */
type SchedulerAdoptMessage = {
  readonly type: "adopt";
  readonly id: string;
  readonly fn: string;
  readonly job: SchedulerJobPayload;
  readonly retry?: RetryOptions;
  /** When the schedule is due in the sub-agent. */
  readonly time: number;
};

type InsertResult<T> = {
  readonly schedule: Schedule<T>;
  readonly created: boolean;
};

function isSchedulerJobPayload(value: unknown): value is SchedulerJobPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SchedulerJobPayload).type === "string"
  );
}

/**
 * Persistent task scheduling for a Lifecycle Object.
 *
 * Register callbacks in the constructor and install the instance with
 * `Lifecycle.use()`. Scheduler validates schedules and pushes them into the
 * Lifecycle job queue; Lifecycle owns the physical alarm and the alarm
 * event loop, and Scheduler runs registered callbacks through Lifecycle's
 * host invocation boundary when its jobs come due.
 */
let declaredScheduleSetOf: (scheduler: Scheduler) => DeclaredScheduleSet;

/**
 * Declare a named set of recurring schedules on `scheduler` and reconcile
 * storage to it: new names are armed at their next occurrence, names whose
 * timing or retry changed are re-armed, names no longer declared are
 * cancelled. Each name has one pending occurrence and never runs twice at
 * once.
 *
 * Call it on every start (for example in `onStart()`), and again after data
 * a function `source` reads changes. The declaration is read again when an
 * occurrence runs. An invalid entry rejects the call and changes nothing.
 *
 * @internal Used by `@cloudflare/think`'s scheduled tasks. Not a public API.
 */
export function declareSchedules(
  scheduler: Scheduler,
  source: DeclaredSchedulesSource,
  options?: DeclareSchedulesOptions
): Promise<void> {
  return declaredScheduleSetOf(scheduler).declare(source, options);
}

/**
 * The armed declared schedules on `scheduler`, ordered by next occurrence.
 *
 * @internal Used by `@cloudflare/think`'s scheduled tasks. Not a public API.
 */
export function listDeclaredSchedules(
  scheduler: Scheduler
): DeclaredScheduleInfo[] {
  return declaredScheduleSetOf(scheduler).list();
}

export class Scheduler<
  Handlers extends SchedulerHandlers = SchedulerCallbacks
> extends LifecycleCapability {
  readonly #handlers: SchedulerHandlers;
  readonly #retryDefaults: Required<RetryOptions>;
  readonly #hungScheduleTimeoutSeconds: number;
  readonly #onError: ((error: unknown) => void | Promise<void>) | undefined;
  readonly #warnedStartupCallbacks = new Set<string>();
  readonly #declared: DeclaredScheduleSet;

  /**
   * Create a persistent Scheduler.
   *
   * @param options - Registered callbacks plus optional retry,
   * hung-interval, and error policy. Registering `callbacks` types
   * {@link set} and {@link every} against the map — names and
   * payloads are checked where the handlers are declared and where they are
   * scheduled. Names outside the map are rejected unless a composition-root
   * resolver supplies them — the internal aperture behind `Agent`'s
   * name-based scheduling API.
   */
  constructor(options: SchedulerOptions<Handlers> = {}) {
    super("scheduler");
    this.#handlers = options.callbacks ?? {};
    // Retry defaults are resolved, not validated, here: a host whose
    // historically tolerated invalid retry config throws at construction
    // would brick every entry point of its Durable Object. Invalid defaults
    // surface per execution as schedule:error instead, and per-schedule
    // retry overrides are still validated when each schedule is created.
    this.#retryDefaults = resolveRetryConfig(options.retry, DEFAULT_RETRY);
    this.#hungScheduleTimeoutSeconds = options.hungScheduleTimeoutSeconds ?? 30;
    this.#onError = options.onError;
    this.#declared = new DeclaredScheduleSet({
      lifecycle: () => this.lifecycle,
      retryDefaults: this.#retryDefaults,
      hungTimeoutSeconds: this.#hungScheduleTimeoutSeconds,
      onError: async (error) => {
        await this.#onError?.(error);
      },
      emit: (type, payload) => this.#emit(type, payload)
    });
  }

  // ── Lifecycle capability hooks ───────────────────────────────────────────

  /** Migrate legacy schedule storage into the Lifecycle job queue. */
  async onStart(): Promise<void> {
    this.#warnedStartupCallbacks.clear();
    await this.#handOverSoon();
    const storage = this.lifecycle.storage;
    const version =
      (await storage.get<number>(SCHEDULE_SCHEMA_VERSION_KEY)) ?? 0;
    if (version >= CURRENT_SCHEDULE_SCHEMA_VERSION) return;

    if (version < 2) await this.#migrateLegacyScheduleTable(storage);
    await this.#declared.migrateLegacy();
    await storage.put(
      SCHEDULE_SCHEMA_VERSION_KEY,
      CURRENT_SCHEDULE_SCHEMA_VERSION
    );
  }

  /**
   * Move every `cf_agents_schedules` row into the job queue and drop the
   * table. Idempotent: a missing table means a fresh object or a completed
   * migration. Times convert from epoch seconds to epoch milliseconds.
   */
  async #migrateLegacyScheduleTable(
    storage: DurableObjectStorage
  ): Promise<void> {
    const tables = storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cf_agents_schedules'"
      )
      .toArray();
    if (tables.length === 0) return;

    const rows = storage.sql
      .exec("SELECT * FROM cf_agents_schedules")
      .toArray() as unknown as ScheduleStorageRow[];
    for (const row of rows) {
      // Keep-alive heartbeats stopped using schedule rows long ago; drop
      // orphans instead of migrating them.
      if (row.callback === "_cf_keepAliveHeartbeat") continue;
      let payload: unknown;
      try {
        payload =
          typeof row.payload === "string" ? JSON.parse(row.payload) : undefined;
      } catch (error) {
        console.error(
          `Skipping schedule "${row.id}" during job-queue migration: ` +
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
        time: row.time * 1000,
        payload: {
          payload,
          retry,
          type: row.type,
          delayInSeconds: row.delayInSeconds ?? undefined,
          cron: row.cron ?? undefined,
          intervalSeconds: row.intervalSeconds ?? undefined,
          owner_path: row.owner_path ?? null,
          owner_path_key: row.owner_path_key ?? null
        } satisfies SchedulerJobPayload,
        retry: resolveRetryConfig(retry, this.#retryDefaults),
        singleflight: row.type === "interval",
        hungTimeoutSeconds: this.#hungScheduleTimeoutSeconds,
        recoveryLoop: LEGACY_RECOVERY_LOOP_CALLBACKS.has(row.callback)
      });
    }
    storage.sql.exec("DROP TABLE cf_agents_schedules");
  }

  /** Drive one due schedule job dispatched by the Lifecycle event loop. */
  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    const { job, attempt } = context;
    if (isDeclaredJob(job)) return this.#declared.run(context);
    const timing = job.payload;
    if (!isSchedulerJobPayload(timing)) {
      console.error(`Malformed schedule job ${job.id}; dropping it`);
      return undefined;
    }

    if (attempt === 1) {
      this.#emit("schedule:execute", { callback: job.fn, id: job.id });
    } else {
      this.#emit("schedule:retry", {
        callback: job.fn,
        id: job.id,
        attempt,
        maxAttempts: resolveRetryConfig(job.retry, this.#retryDefaults)
          .maxAttempts
      });
    }

    if (timing.owner_path) return this.#handOver(job, timing);

    const handler = this.#resolveCallback(job.fn);
    if (!handler) {
      console.error(`callback ${job.fn} not found`);
      return this.#recurrenceOutcome(timing);
    }
    const schedule = this.#jobToSchedule<unknown>(job, timing);
    await this.lifecycle.runInHostContext(() =>
      handler(timing.payload, schedule)
    );
    return this.#recurrenceOutcome(timing);
  }

  /** Observe one schedule's terminal application failure. */
  async onJobError(
    context: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome | void> {
    const { job } = context;
    if (isDeclaredJob(job)) return this.#declared.runFailed(context, error);
    const timing = job.payload;
    if (!isSchedulerJobPayload(timing)) return undefined;
    const { maxAttempts } = resolveRetryConfig(job.retry, this.#retryDefaults);
    console.error(
      `error executing callback "${job.fn}" after ${maxAttempts} attempts`,
      error
    );
    this.#emit("schedule:error", {
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
    return this.#recurrenceOutcome(timing);
  }

  /** Advance a recurring schedule; complete a one-shot. */
  #recurrenceOutcome(timing: SchedulerJobPayload): LifecycleJobOutcome {
    if (timing.type === "cron") {
      return { rescheduleAt: nextCronTimeMs(timing.cron ?? "", Date.now()) };
    }
    if (timing.type === "interval") {
      return {
        rescheduleAt: Date.now() + (timing.intervalSeconds ?? 0) * 1000
      };
    }
    return undefined;
  }

  /**
   * TEMPORARY, for schedules a root held for a sub-agent before this
   * release: when one comes due, the root hands it to the sub-agent's own
   * Scheduler, due now, and drops its copy. A path that is gone drops the
   * schedule. Remove with the next minor release.
   */
  /**
   * TEMPORARY: make every schedule this root holds for a sub-agent due now,
   * keeping its own time in the payload, so it is handed over on this
   * start's first alarm instead of when it comes due. Until then the
   * sub-agent cannot see, cancel or deduplicate against it.
   */
  async #handOverSoon(): Promise<void> {
    const now = Date.now();
    for (const { job, timing } of this.#ownedJobs()) {
      if (!timing.owner_path || timing.handover_time !== undefined) continue;
      if (job.time <= now) continue;
      await this.lifecycle.jobs.push({
        id: job.id,
        fn: job.fn,
        time: now,
        payload: { ...timing, handover_time: job.time },
        retry: job.retry,
        singleflight: job.singleflight,
        hungTimeoutSeconds: this.#hungScheduleTimeoutSeconds,
        recoveryLoop: job.recoveryLoop
      });
    }
  }

  async #handOver(
    job: LifecycleJob,
    timing: SchedulerJobPayload
  ): Promise<LifecycleJobOutcome | void> {
    const { owner_path, owner_path_key, handover_time, ...rest } = timing;
    try {
      await this.lifecycle.routes.to(
        { key: owner_path_key ?? owner_path!, data: owner_path! },
        {
          type: "adopt",
          id: job.id,
          fn: job.fn,
          job: rest,
          retry: job.retry,
          time: handover_time ?? job.time
        } satisfies SchedulerAdoptMessage
      );
    } catch (error) {
      // Keep the schedule for a later alarm; platform failures go to the
      // driver's own handling.
      if (isPlatformFailure(error)) throw error;
      console.error(`error handing schedule "${job.id}" over`, error);
      return "yield";
    }
    return undefined;
  }

  /**
   * In a sub-agent: take over a schedule its root held for it, at its own
   * time. When the sub-agent already created the same schedule itself since
   * the upgrade (an `onStart` that schedules again, idempotent or not), the
   * two are one: the earlier time is kept and nothing is added. Schedules
   * handed over are never merged with each other.
   */
  async onRoute(context: LifecycleRouteContext): Promise<unknown> {
    const message = context.payload as SchedulerAdoptMessage;
    if (message.type !== "adopt") {
      throw new Error("Unknown routed Scheduler message");
    }
    const { id, fn, job, time } = message;
    if (this.lifecycle.jobs.get(id)) return true;
    const copy = this.#ownedJobs().find(
      ({ job: held, timing }) =>
        !timing.adopted &&
        held.fn === fn &&
        timing.type === job.type &&
        timing.cron === job.cron &&
        timing.intervalSeconds === job.intervalSeconds &&
        JSON.stringify(timing.payload) === JSON.stringify(job.payload)
    );
    if (copy) {
      if (time < copy.job.time) {
        await this.lifecycle.jobs.reschedule(copy.job.id, time);
      }
      return true;
    }
    await this.lifecycle.jobs.push({
      id,
      fn,
      time,
      payload: { ...job, adopted: true } satisfies SchedulerJobPayload,
      retry: message.retry,
      singleflight: job.type === "interval",
      hungTimeoutSeconds: this.#hungScheduleTimeoutSeconds,
      recoveryLoop: LEGACY_RECOVERY_LOOP_CALLBACKS.has(fn)
    });
    return true;
  }

  // ── Scheduling API ───────────────────────────────────────────────────────

  /** Set a delayed, dated, or cron schedule for a registered callback. */
  async set<Name extends keyof Handlers & string>(
    when: Date | string | number,
    callback: Name,
    payload?: SchedulerPayload<Handlers[Name]>,
    options?: ScheduleOptions
  ): Promise<Schedule<SchedulerPayload<Handlers[Name]>>> {
    await this.lifecycle.ready();
    this.#validateSchedule(when, callback, options);
    const result = await this.#insert<SchedulerPayload<Handlers[Name]>>(
      parseWhen(when, Date.now(), callback),
      callback,
      payload,
      options
    );
    this.#emitCreated(result);
    return result.schedule;
  }

  /** Set a fixed-interval schedule for a registered callback. */
  async every<Name extends keyof Handlers & string>(
    intervalSeconds: number,
    callback: Name,
    payload?: SchedulerPayload<Handlers[Name]>,
    options?: ScheduleOptions
  ): Promise<Schedule<SchedulerPayload<Handlers[Name]>>> {
    await this.lifecycle.ready();
    this.#validateInterval(intervalSeconds, callback, options?.retry);
    const result = await this.#insert<SchedulerPayload<Handlers[Name]>>(
      parseInterval(intervalSeconds, Date.now()),
      callback,
      payload,
      options
    );
    this.#emitCreated(result);
    return result.schedule;
  }

  /** Get a schedule by ID. */
  async get(id: string): Promise<Schedule<unknown> | undefined> {
    await this.lifecycle.ready();
    return this.#get(id);
  }

  /** List schedules matching criteria. */
  async list(criteria: ScheduleCriteria = {}): Promise<Schedule<unknown>[]> {
    await this.lifecycle.ready();
    return this.#list(criteria);
  }

  /**
   * Cancel one schedule owned by this Scheduler.
   *
   * @param id - ID of the schedule to cancel.
   * @returns True when a schedule was cancelled, false when none matched.
   */
  async cancel(id: string): Promise<boolean> {
    await this.lifecycle.ready();
    const result = await this.#cancel(id);
    if (result.ok && result.callback) {
      this.#emit("schedule:cancel", { callback: result.callback, id });
    }
    return result.ok;
  }

  static {
    declaredScheduleSetOf = (scheduler) => scheduler.#declared;
  }

  // ── Host-owned policy apertures ──────────────────────────────────────────

  /**
   * @internal Synchronous read backing Agent's deprecated `getSchedule()`.
   * Not part of the primitive's contract — use {@link get}.
   */
  __DO_NOT_USE_WILL_REMOVE__getSchedule<T = string>(
    id: string
  ): Schedule<T> | undefined {
    return this.#get(id);
  }

  /**
   * @internal Synchronous read backing Agent's deprecated `getSchedules()`.
   * Not part of the primitive's contract — use {@link list}.
   */
  __DO_NOT_USE_WILL_REMOVE__getSchedules<T = string>(
    criteria: ScheduleCriteria = {}
  ): Schedule<T>[] {
    return this.#list(criteria);
  }

  // ── Validation ───────────────────────────────────────────────────────────

  #validateSchedule(
    when: Date | string | number,
    callback: string,
    options?: ScheduleOptions
  ): void {
    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }
    if (!this.#hasCallback(callback)) {
      throw new Error(
        `Unknown scheduled callback "${callback}": not registered on this Scheduler`
      );
    }
    if (options?.retry) {
      validateRetryOptions(options.retry, this.#retryDefaults);
    }
    if (
      !(when instanceof Date) &&
      typeof when !== "number" &&
      typeof when !== "string"
    ) {
      throw new Error(
        `Invalid schedule type: ${JSON.stringify(when)}(${typeof when}) trying to schedule ${callback}`
      );
    }
    this.#warnWhenScheduledDuringStartup(when, callback, options);
  }

  #validateInterval(
    intervalSeconds: number,
    callback: string,
    retry?: RetryOptions
  ): void {
    validateIntervalSeconds(intervalSeconds);
    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }
    if (!this.#hasCallback(callback)) {
      throw new Error(
        `Unknown scheduled callback "${callback}": not registered on this Scheduler`
      );
    }
    if (retry) validateRetryOptions(retry, this.#retryDefaults);
  }

  /**
   * A non-idempotent one-shot created during startup accumulates one row per
   * Durable Object wake, whether it came from the host's onStart or another
   * startup hook. Warn once per callback; an explicit `idempotent` choice
   * (either value) opts out.
   */
  #warnWhenScheduledDuringStartup(
    when: Date | string | number,
    callback: string,
    options?: ScheduleOptions
  ): void {
    if (this.lifecycle.status() !== "starting") return;
    if (options?.idempotent !== undefined) return;
    if (typeof when === "string") return;
    if (this.#warnedStartupCallbacks.has(callback)) return;
    this.#warnedStartupCallbacks.add(callback);
    console.warn(
      `Scheduling "${callback}" during startup (e.g. onStart()) without ` +
        `{ idempotent: true } creates a new row on every Durable Object ` +
        `restart, which can cause duplicate executions. Pass ` +
        `{ idempotent: true } to deduplicate, or use an interval schedule ` +
        `for recurring tasks.`
    );
  }

  /** Resolve a name to its registered or composition-root-supplied handler. */
  #resolveCallback(name: string): ResolvedSchedulerCallback | undefined {
    const handler = this.#handlers[name];
    if (handler) {
      // SAFETY: registered handlers are constrained with `never` parameters
      // so concrete handler types satisfy the map under contravariance; the
      // payload passed at dispatch was persisted with this handler's name.
      return handler as ResolvedSchedulerCallback;
    }
    return schedulerCallbackResolvers.get(this)?.(name);
  }

  /** True when a name resolves to a runnable callback. */
  #hasCallback(name: string): boolean {
    return this.#resolveCallback(name) !== undefined;
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  /** Every schedule job this Scheduler owns, with its parsed vocabulary. */
  #ownedJobs(): Array<{ job: LifecycleJob; timing: SchedulerJobPayload }> {
    const owned: Array<{ job: LifecycleJob; timing: SchedulerJobPayload }> = [];
    for (const job of this.lifecycle.jobs.list()) {
      if (isSchedulerJobPayload(job.payload)) {
        owned.push({ job, timing: job.payload });
      }
    }
    return owned;
  }

  /**
   * Push a schedule job, or return the existing job
   * when an idempotent request matches one. One-shot timings deduplicate only
   * when `idempotent: true` is passed; recurring timings deduplicate unless
   * `idempotent: false` opts out. `created: false` marks a dedup hit so
   * callers suppress the `schedule:create` event.
   */
  async #insert<T = string>(
    timing: ScheduleTiming,
    callback: string,
    payload: unknown,
    options?: ScheduleOptions
  ): Promise<InsertResult<T>> {
    // Recurring timings deduplicate unless explicitly opted out; one-shot
    // timings deduplicate on any truthy value (historic Agent behavior).
    const idempotent = isRecurring(timing)
      ? options?.idempotent !== false
      : Boolean(options?.idempotent);
    // Not part of public ScheduleOptions. See RecoveryLoopScheduleOptions.
    const recoveryLoop = (
      options as Partial<RecoveryLoopScheduleOptions> | undefined
    )?.recoveryLoop;

    if (idempotent) {
      const existing = this.#findMatchingJob(
        timing,
        callback,
        JSON.stringify(payload)
      );
      if (existing) {
        // A dedup hit onto a row without breaker membership the caller asks
        // for (a row migrated from the legacy schedule table) re-pushes the
        // same durable intent in place with the flag — otherwise the row
        // would escape the alarm memory-limit breaker (#1825) forever.
        if (recoveryLoop && !existing.job.recoveryLoop) {
          await this.lifecycle.jobs.push({
            id: existing.job.id,
            fn: existing.job.fn,
            time: existing.job.time,
            payload: existing.job.payload,
            retry: existing.job.retry,
            singleflight: existing.job.singleflight,
            exclusive: existing.job.exclusive,
            hungTimeoutSeconds: this.#hungScheduleTimeoutSeconds,
            recoveryLoop: true
          });
        }
        // A dedup hit still re-arms so a lost physical alarm recovers, as
        // idempotent re-scheduling on startup historically guaranteed.
        await this.lifecycle.jobs.rearm();
        return {
          schedule: this.#jobToSchedule<T>(existing.job, existing.timing),
          created: false
        };
      }
    }

    const jobPayload: SchedulerJobPayload = {
      payload,
      retry: options?.retry,
      type: timing.type,
      delayInSeconds:
        timing.type === "delayed" ? timing.delayInSeconds : undefined,
      cron: timing.type === "cron" ? timing.cron : undefined,
      intervalSeconds:
        timing.type === "interval" ? timing.intervalSeconds : undefined
    };
    const job = await this.lifecycle.jobs.push({
      fn: callback,
      time: timing.time * 1000,
      payload: jobPayload,
      retry: resolveRetryConfig(options?.retry, this.#retryDefaults),
      singleflight: timing.type === "interval",
      hungTimeoutSeconds: this.#hungScheduleTimeoutSeconds,
      recoveryLoop
    });

    return {
      schedule: {
        id: job.id,
        callback,
        // SAFETY: payload is optional at the call site; historical API shape
        // types an omitted payload as the schedule's payload type.
        payload: payload as T,
        retry: options?.retry,
        ...timing
      },
      created: true
    };
  }

  /** Find the job an idempotent insert deduplicates onto, if any. */
  #findMatchingJob(
    timing: ScheduleTiming,
    callback: string,
    payloadJson: string
  ): { job: LifecycleJob; timing: SchedulerJobPayload } | undefined {
    for (const owned of this.#ownedJobs()) {
      const { job, timing: candidate } = owned;
      if (candidate.type !== timing.type) continue;
      if (job.fn !== callback) continue;
      if (candidate.owner_path) continue;
      if (JSON.stringify(candidate.payload) !== payloadJson) continue;
      if (timing.type === "cron" && candidate.cron !== timing.cron) continue;
      if (
        timing.type === "interval" &&
        candidate.intervalSeconds !== timing.intervalSeconds
      ) {
        continue;
      }
      return owned;
    }
    return undefined;
  }

  #jobToSchedule<T>(
    job: LifecycleJob,
    timing: SchedulerJobPayload
  ): Schedule<T> {
    return this.#payloadToSchedule<T>(
      job.id,
      job.fn,
      timing,
      Math.floor(job.time / 1000)
    );
  }

  #payloadToSchedule<T>(
    id: string,
    fn: string,
    timing: SchedulerJobPayload,
    timeSeconds?: number
  ): Schedule<T> {
    const base = {
      callback: fn,
      id,
      payload: timing.payload as T,
      retry: timing.retry
    };
    const time = timeSeconds ?? 0;
    switch (timing.type) {
      case "scheduled":
        return { ...base, time, type: "scheduled" };
      case "delayed":
        return {
          ...base,
          delayInSeconds: timing.delayInSeconds ?? 0,
          time,
          type: "delayed"
        };
      case "cron":
        return { ...base, cron: timing.cron ?? "", time, type: "cron" };
      case "interval":
        return {
          ...base,
          intervalSeconds: timing.intervalSeconds ?? 0,
          time,
          type: "interval"
        };
    }
  }

  /** One schedule this Scheduler holds for itself (not for a sub-agent). */
  #get<T = string>(id: string): Schedule<T> | undefined {
    const job = this.lifecycle.jobs.get(id);
    if (!job || !isSchedulerJobPayload(job.payload)) return undefined;
    if (job.payload.owner_path) return undefined;
    return this.#jobToSchedule<T>(job, job.payload);
  }

  #list<T = string>(criteria: ScheduleCriteria = {}): Schedule<T>[] {
    const startSeconds = criteria.timeRange
      ? Math.floor((criteria.timeRange.start ?? new Date(0)).getTime() / 1000)
      : null;
    const endSeconds = criteria.timeRange
      ? Math.floor(
          (criteria.timeRange.end ?? new Date(999999999999999)).getTime() / 1000
        )
      : null;

    const schedules: Schedule<T>[] = [];
    for (const { job, timing } of this.#ownedJobs()) {
      if (timing.owner_path) continue;
      if (criteria.id && job.id !== criteria.id) continue;
      if (criteria.type && timing.type !== criteria.type) continue;
      const timeSeconds = Math.floor(job.time / 1000);
      if (startSeconds !== null && timeSeconds < startSeconds) continue;
      if (endSeconds !== null && timeSeconds > endSeconds) continue;
      schedules.push(this.#jobToSchedule<T>(job, timing));
    }
    return schedules;
  }

  async #cancel(id: string): Promise<{ ok: boolean; callback?: string }> {
    const job = this.lifecycle.jobs.get(id);
    if (!job || !isSchedulerJobPayload(job.payload)) return { ok: false };
    if (job.payload.owner_path) return { ok: false };
    const callback = job.fn;
    await this.lifecycle.jobs.cancel(id);
    return { ok: true, callback };
  }

  // ── Events ───────────────────────────────────────────────────────────────

  #emit(type: SchedulerEventType, payload: Record<string, unknown>): void {
    this.lifecycle.events.emit(type, payload);
  }

  #emitCreated(result: InsertResult<unknown>): void {
    if (!result.created) return;
    this.#emit("schedule:create", {
      callback: result.schedule.callback,
      id: result.schedule.id
    });
  }
}
