/**
 * Lifecycle scheduling primitive. Owns the `cf_agents_schedules` table,
 * callback retry policy, and due-row processing.
 *
 * Scheduler consumes only the standard capability services: storage, alarm
 * coordination, host callbacks, events, and routing. Lifecycle combines
 * Scheduler's next wake-up candidate with contributions from other
 * capabilities and the host before arming the Durable Object.
 */

import { nanoid } from "nanoid";
import {
  LifecycleCapability,
  type LifecycleRouteAddress,
  type LifecycleRouteContext
} from "../lifecycle/capability";
import type { LifecycleObject } from "../lifecycle/current-agent";
import {
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
  isPlatformTransientError,
  tryN,
  validateRetryOptions
} from "../retries";
import type { RetryOptions } from "../retries";
import { SqlError } from "../sql-error";
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
  Schedule,
  ScheduleCriteria,
  ScheduleOptions,
  ScheduleStorageRow
} from "./types";

const SCHEDULE_SCHEMA_VERSION_KEY = "cf_agents:schedules_schema_version";
const CURRENT_SCHEDULE_SCHEMA_VERSION = 1;

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 3000
};

type SchedulerRouteMessage =
  | {
      readonly type: "schedule";
      readonly when: Date | string | number;
      readonly callback: string;
      readonly payload?: unknown;
      readonly options?: ScheduleOptions;
    }
  | {
      readonly type: "every";
      readonly intervalSeconds: number;
      readonly callback: string;
      readonly payload?: unknown;
      readonly options?: ScheduleOptions;
    }
  | { readonly type: "get" | "cancel"; readonly id: string }
  | { readonly type: "list"; readonly criteria?: ScheduleCriteria }
  | { readonly type: "dispatch"; readonly row: ScheduleStorageRow };

type InsertResult<T> = {
  readonly schedule: Schedule<T>;
  readonly created: boolean;
};

function parseRetryOptions(row: ScheduleStorageRow): RetryOptions | undefined {
  return typeof row.retry_options === "string"
    ? (JSON.parse(row.retry_options) as RetryOptions)
    : undefined;
}

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

/**
 * Persistent task scheduling for a Lifecycle Object.
 *
 * Construct with the host and install the same instance with
 * `Lifecycle.use()`. Scheduler owns its SQL schema, task CRUD, callback
 * retries, and due-row processing. It contributes its next wake time while
 * Lifecycle owns the physical alarm, and it invokes named host callbacks
 * through Lifecycle's host-callback boundary.
 */
export class Scheduler<
  Host extends LifecycleObject = LifecycleObject
> extends LifecycleCapability {
  readonly #retryDefaults: Required<RetryOptions>;
  readonly #hungScheduleTimeoutSeconds: number;
  readonly #onError: ((error: unknown) => void | Promise<void>) | undefined;
  readonly #warnedStartupCallbacks = new Set<string>();
  #executingRowId: string | undefined;

  /**
   * Create a persistent Scheduler targeting named methods on the host.
   *
   * @param _host - The Lifecycle Object whose named methods scheduled
   * callbacks invoke — the same object this Scheduler is installed on. It
   * anchors callback typing for {@link set} and {@link every}; dispatch runs
   * through the installing Lifecycle.
   * @param options - Optional retry, hung-interval, and error policy.
   */
  constructor(_host: Host, options: SchedulerOptions = {}) {
    super("scheduler");
    // Retry defaults are resolved, not validated, here: a host whose
    // historically tolerated invalid retry config throws at construction
    // would brick every entry point of its Durable Object. Invalid defaults
    // surface per execution as schedule:error instead, and per-schedule
    // retry overrides are still validated when each schedule is created.
    this.#retryDefaults = resolveRetryConfig(options.retry, DEFAULT_RETRY);
    this.#hungScheduleTimeoutSeconds = options.hungScheduleTimeoutSeconds ?? 30;
    this.#onError = options.onError;
  }

  // ── Lifecycle capability hooks ───────────────────────────────────────────

  /** Initialize and migrate schedule storage during Lifecycle startup. */
  async onStart(): Promise<void> {
    this.#warnedStartupCallbacks.clear();
    const storage = this.lifecycle.storage;
    const version =
      (await storage.get<number>(SCHEDULE_SCHEMA_VERSION_KEY)) ?? 0;
    if (version >= CURRENT_SCHEDULE_SCHEMA_VERSION) return;

    this.#migrateSchema();
    await storage.put(
      SCHEDULE_SCHEMA_VERSION_KEY,
      CURRENT_SCHEDULE_SCHEMA_VERSION
    );
  }

  /** Execute due schedule rows during the Lifecycle alarm phase. */
  async onAlarm(): Promise<void> {
    await this.#fireDueSchedules();
  }

  /** Handle Scheduler protocol messages routed by another Lifecycle. */
  async onRoute(context: LifecycleRouteContext): Promise<unknown> {
    const message = context.payload as SchedulerRouteMessage;
    const owner = context.source ?? null;
    switch (message.type) {
      case "schedule":
        return this.#insert(
          owner,
          parseWhen(message.when, Date.now(), message.callback),
          message.callback,
          message.payload,
          message.options
        );
      case "every":
        return this.#insert(
          owner,
          parseInterval(message.intervalSeconds, Date.now()),
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
      case "dispatch":
        await this.#executeCallback(message.row);
        return true;
      default:
        throw new Error("Unknown routed Scheduler message");
    }
  }

  /** Contribute the earliest pending schedule to Lifecycle alarm selection. */
  getNextAlarm(): number | null {
    const nowMs = Date.now();
    const hungCutoffSeconds =
      Math.floor(nowMs / 1000) - this.#hungScheduleTimeoutSeconds;
    const nextSchedule = this.#nextScheduleTimeMs(nowMs, hungCutoffSeconds);
    const hungIntervalRecheck =
      this.#nextHungIntervalRecheckMs(hungCutoffSeconds);
    if (nextSchedule === null) return hungIntervalRecheck;
    if (hungIntervalRecheck === null) return nextSchedule;
    return Math.min(nextSchedule, hungIntervalRecheck);
  }

  // ── Scheduling API ───────────────────────────────────────────────────────

  /** Schedule a delayed, dated, or cron callback by name. */
  async schedule<T = string>(
    when: Date | string | number,
    callback: string,
    payload?: T,
    options?: ScheduleOptions
  ): Promise<Schedule<T>> {
    await this.lifecycle.ready();
    this.#validateSchedule(when, callback, options);
    const result = this.lifecycle.routes.source
      ? ((await this.lifecycle.routes.toRoot({
          type: "schedule",
          when,
          callback,
          payload,
          options
        } satisfies SchedulerRouteMessage)) as InsertResult<T>)
      : await this.#insert<T>(
          null,
          parseWhen(when, Date.now(), callback),
          callback,
          payload,
          options
        );
    this.#emitCreated(result);
    return result.schedule;
  }

  /** Set a delayed, dated, or cron callback on this Scheduler's host. */
  set<
    Name extends keyof Host,
    Method extends Extract<Host[Name], (...args: never[]) => unknown>
  >(
    when: Date | string | number,
    callback: Name,
    payload: Parameters<Method>[0],
    options?: ScheduleOptions
  ): Promise<Schedule<Parameters<Method>[0]>> {
    return this.schedule(when, callback as string, payload, options) as Promise<
      Schedule<Parameters<Method>[0]>
    >;
  }

  /** Schedule a callback at a fixed interval by name. */
  async scheduleEvery<T = string>(
    intervalSeconds: number,
    callback: string,
    payload?: T,
    options?: ScheduleOptions
  ): Promise<Schedule<T>> {
    await this.lifecycle.ready();
    this.#validateInterval(intervalSeconds, callback, options?.retry);
    const result = this.lifecycle.routes.source
      ? ((await this.lifecycle.routes.toRoot({
          type: "every",
          intervalSeconds,
          callback,
          payload,
          options
        } satisfies SchedulerRouteMessage)) as InsertResult<T>)
      : await this.#insert<T>(
          null,
          parseInterval(intervalSeconds, Date.now()),
          callback,
          payload,
          options
        );
    this.#emitCreated(result);
    return result.schedule;
  }

  /** Set a fixed-interval callback on this Scheduler's host. */
  every<
    Name extends keyof Host,
    Method extends Extract<Host[Name], (...args: never[]) => unknown>
  >(
    intervalSeconds: number,
    callback: Name,
    payload: Parameters<Method>[0],
    options?: ScheduleOptions
  ): Promise<Schedule<Parameters<Method>[0]>> {
    return this.scheduleEvery(
      intervalSeconds,
      callback as string,
      payload,
      options
    ) as Promise<Schedule<Parameters<Method>[0]>>;
  }

  /** Get a schedule by ID. Works inside routed sub-agents. */
  async get(id: string): Promise<Schedule<unknown> | undefined> {
    await this.lifecycle.ready();
    return this.lifecycle.routes.source
      ? ((await this.lifecycle.routes.toRoot({
          type: "get",
          id
        } satisfies SchedulerRouteMessage)) as Schedule<unknown> | undefined)
      : this.#getForOwner(null, id);
  }

  /** List schedules matching criteria. Works inside routed sub-agents. */
  async list(criteria: ScheduleCriteria = {}): Promise<Schedule<unknown>[]> {
    await this.lifecycle.ready();
    return this.lifecycle.routes.source
      ? ((await this.lifecycle.routes.toRoot({
          type: "list",
          criteria
        } satisfies SchedulerRouteMessage)) as Schedule<unknown>[])
      : this.#listForOwner(null, criteria);
  }

  /**
   * Cancel one schedule owned by this Scheduler.
   *
   * @param id - ID of the schedule to cancel.
   * @returns True when a schedule was cancelled, false when none matched.
   */
  async cancel(id: string): Promise<boolean> {
    await this.lifecycle.ready();
    const result = this.lifecycle.routes.source
      ? ((await this.lifecycle.routes.toRoot({
          type: "cancel",
          id
        } satisfies SchedulerRouteMessage)) as {
          ok: boolean;
          callback?: string;
        })
      : await this.#cancelForOwner(null, id);
    if (result.ok && result.callback) {
      this.#emit("schedule:cancel", { callback: result.callback, id });
    }
    return result.ok;
  }

  /**
   * Get a schedule by ID.
   *
   * @deprecated Use {@link get}. This synchronous API cannot cross Durable
   * Object boundaries and throws inside routed sub-agents.
   */
  getSchedule<T = string>(id: string): Schedule<T> | undefined {
    if (this.lifecycle.routes.source) {
      throw new Error(
        "getSchedule() is synchronous and cannot read routed schedule storage. " +
          "Use await scheduler.get(id) instead."
      );
    }
    return this.#getForOwner(null, id);
  }

  /**
   * List schedules matching criteria.
   *
   * @deprecated Use {@link list}. This synchronous API cannot cross Durable
   * Object boundaries and throws inside routed sub-agents.
   */
  getSchedules<T = string>(criteria: ScheduleCriteria = {}): Schedule<T>[] {
    if (this.lifecycle.routes.source) {
      throw new Error(
        "getSchedules() is synchronous and cannot read routed schedule storage. " +
          "Use await scheduler.list(criteria) instead."
      );
    }
    return this.#listForOwner(null, criteria);
  }

  // ── Host-owned policy apertures ──────────────────────────────────────────

  /** @internal Remove rows owned by one routed Lifecycle subtree. */
  cleanupRoutePrefix(prefix: string): void {
    this.#cancelOwners(
      (owner) => owner.key === prefix || owner.key.startsWith(`${prefix}/`)
    );
  }

  /** @internal Apply Agent's outer alarm memory-limit policy to Scheduler rows. */
  handleAlarmMemoryLimit(options: {
    readonly callbacks: ReadonlyArray<string>;
    readonly sealed: boolean;
    readonly nextTime?: number;
  }): void {
    const executingRowId = this.#executingRowId;
    this.#executingRowId = undefined;
    if (options.sealed) {
      this.#deleteRows(options.callbacks, executingRowId);
      return;
    }
    if (options.nextTime === undefined) {
      throw new Error("Scheduler memory-limit backoff requires nextTime");
    }
    this.#moveRows(options.callbacks, executingRowId, options.nextTime);
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
    if (!this.lifecycle.callbacks.has(callback)) {
      throw new Error(`this.${callback} is not a function`);
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
    if (!this.lifecycle.callbacks.has(callback)) {
      throw new Error(`this.${callback} is not a function`);
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
    if (!this.lifecycle.starting()) return;
    if (options?.idempotent !== undefined) return;
    if (typeof when === "string") return;
    if (this.#warnedStartupCallbacks.has(callback)) return;
    this.#warnedStartupCallbacks.add(callback);
    console.warn(
      `schedule("${callback}") called during startup (e.g. onStart()) without ` +
        `{ idempotent: true }. This creates a new row on every Durable Object ` +
        `restart, which can cause duplicate executions. Pass { idempotent: true } ` +
        `to deduplicate, or use scheduleEvery() for recurring tasks.`
    );
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  #sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const query = strings.reduce(
      (result, part, index) =>
        result + part + (index < values.length ? "?" : ""),
      ""
    );
    try {
      // SAFETY: Scheduler queries select from its own schema; T describes the
      // projected columns of the accompanying query text.
      return [...this.lifecycle.storage.sql.exec(query, ...values)] as T[];
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  #migrateSchema(): void {
    const rawSql = (query: string, ...params: (string | number | null)[]) =>
      this.lifecycle.storage.sql.exec(query, ...params);

    rawSql(`
        CREATE TABLE IF NOT EXISTS cf_agents_schedules (
          id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
          callback TEXT,
          payload TEXT,
          type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
          time INTEGER,
          delayInSeconds INTEGER,
          cron TEXT,
          intervalSeconds INTEGER,
          running INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (unixepoch()),
          execution_started_at INTEGER,
          retry_options TEXT,
          owner_path TEXT,
          owner_path_key TEXT
        )
      `);

    const addColumnIfMissing = (statement: string): void => {
      try {
        rawSql(statement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("duplicate column")) throw error;
      }
    };
    addColumnIfMissing(
      "ALTER TABLE cf_agents_schedules ADD COLUMN intervalSeconds INTEGER"
    );
    addColumnIfMissing(
      "ALTER TABLE cf_agents_schedules ADD COLUMN running INTEGER DEFAULT 0"
    );
    addColumnIfMissing(
      "ALTER TABLE cf_agents_schedules ADD COLUMN execution_started_at INTEGER"
    );
    addColumnIfMissing(
      "ALTER TABLE cf_agents_schedules ADD COLUMN retry_options TEXT"
    );
    addColumnIfMissing(
      "ALTER TABLE cf_agents_schedules ADD COLUMN owner_path TEXT"
    );
    addColumnIfMissing(
      "ALTER TABLE cf_agents_schedules ADD COLUMN owner_path_key TEXT"
    );

    const rows = rawSql(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='cf_agents_schedules'"
    ).toArray();
    const ddl = typeof rows[0]?.sql === "string" ? rows[0].sql : "";
    if (ddl && !ddl.includes("'interval'")) {
      rawSql("DROP TABLE IF EXISTS cf_agents_schedules_new");
      rawSql(`
          CREATE TABLE cf_agents_schedules_new (
            id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
            callback TEXT,
            payload TEXT,
            type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
            time INTEGER,
            delayInSeconds INTEGER,
            cron TEXT,
            intervalSeconds INTEGER,
            running INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (unixepoch()),
            execution_started_at INTEGER,
            retry_options TEXT,
            owner_path TEXT,
            owner_path_key TEXT
          )
        `);
      rawSql(`
        INSERT INTO cf_agents_schedules_new
          (id, callback, payload, type, time, delayInSeconds, cron,
           intervalSeconds, running, created_at, execution_started_at,
           retry_options, owner_path, owner_path_key)
        SELECT id, callback, payload, type, time, delayInSeconds, cron,
               intervalSeconds, running, created_at, execution_started_at,
               retry_options, owner_path, owner_path_key
        FROM cf_agents_schedules
      `);
      rawSql("DROP TABLE cf_agents_schedules");
      rawSql(
        "ALTER TABLE cf_agents_schedules_new RENAME TO cf_agents_schedules"
      );
    }

    // Keep-alive no longer uses schedule rows. Remove orphaned heartbeat rows
    // left by older Scheduler versions.
    rawSql(
      "DELETE FROM cf_agents_schedules WHERE callback = '_cf_keepAliveHeartbeat'"
    );
  }

  /**
   * Insert a schedule row for the given owner, or return the existing row
   * when an idempotent request matches one. One-shot timings deduplicate only
   * when `idempotent: true` is passed; recurring timings deduplicate unless
   * `idempotent: false` opts out. `created: false` marks a dedup hit so
   * callers suppress the `schedule:create` event.
   */
  async #insert<T = string>(
    owner: LifecycleRouteAddress | null,
    timing: ScheduleTiming,
    callback: string,
    payload: unknown,
    options?: ScheduleOptions
  ): Promise<InsertResult<T>> {
    const payloadJson = JSON.stringify(payload);
    // Recurring timings deduplicate unless explicitly opted out; one-shot
    // timings deduplicate on any truthy value (historic Agent behavior).
    const idempotent = isRecurring(timing)
      ? options?.idempotent !== false
      : Boolean(options?.idempotent);

    if (idempotent) {
      const existing = this.#findMatchingRow(
        owner?.key ?? null,
        timing,
        callback,
        payloadJson
      );
      if (existing) {
        await this.lifecycle.alarms.rearm();
        return { schedule: this.#rowToSchedule<T>(existing), created: false };
      }
    }

    const id = nanoid(9);
    this.#sql`
      INSERT OR REPLACE INTO cf_agents_schedules
        (id, callback, payload, type, time, delayInSeconds, cron,
         intervalSeconds, running, retry_options, owner_path, owner_path_key)
      VALUES
        (${id}, ${callback}, ${payloadJson}, ${timing.type}, ${timing.time},
         ${timing.type === "delayed" ? timing.delayInSeconds : null},
         ${timing.type === "cron" ? timing.cron : null},
         ${timing.type === "interval" ? timing.intervalSeconds : null},
         0,
         ${options?.retry ? JSON.stringify(options.retry) : null},
         ${owner?.data ?? null}, ${owner?.key ?? null})
    `;
    await this.lifecycle.alarms.rearm();

    return {
      schedule: {
        id,
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

  /** Find the row an idempotent insert deduplicates onto, if any. */
  #findMatchingRow(
    ownerKey: string | null,
    timing: ScheduleTiming,
    callback: string,
    payloadJson: string
  ): ScheduleStorageRow | undefined {
    let query =
      "SELECT * FROM cf_agents_schedules " +
      "WHERE type = ? AND callback = ? AND payload IS ? AND owner_path_key IS ?";
    const params: (string | number | null)[] = [
      timing.type,
      callback,
      payloadJson,
      ownerKey
    ];
    if (timing.type === "cron") {
      query += " AND cron = ?";
      params.push(timing.cron);
    }
    if (timing.type === "interval") {
      query += " AND intervalSeconds = ?";
      params.push(timing.intervalSeconds);
    }
    let rows: unknown[];
    try {
      rows = this.lifecycle.storage.sql.exec(query, ...params).toArray();
    } catch (cause) {
      throw new SqlError(query, cause);
    }
    // SAFETY: the query selects * from Scheduler's own schema.
    return rows[0] as ScheduleStorageRow | undefined;
  }

  #rowToSchedule<T>(row: ScheduleStorageRow): Schedule<T> {
    const base = {
      callback: row.callback,
      id: row.id,
      payload: JSON.parse(row.payload) as T,
      retry: parseRetryOptions(row)
    };

    switch (row.type) {
      case "scheduled":
        return { ...base, time: row.time, type: "scheduled" };
      case "delayed":
        return {
          ...base,
          delayInSeconds: row.delayInSeconds ?? 0,
          time: row.time,
          type: "delayed"
        };
      case "cron":
        return { ...base, cron: row.cron ?? "", time: row.time, type: "cron" };
      case "interval":
        return {
          ...base,
          intervalSeconds: row.intervalSeconds ?? 0,
          time: row.time,
          type: "interval"
        };
    }
  }

  #getForOwner<T = string>(
    owner: LifecycleRouteAddress | null,
    id: string
  ): Schedule<T> | undefined {
    const ownerPathKey = owner?.key ?? null;
    const result = this.#sql<ScheduleStorageRow>`
      SELECT * FROM cf_agents_schedules
      WHERE id = ${id} AND owner_path_key IS ${ownerPathKey}
    `;
    if (result.length === 0) return undefined;
    return this.#rowToSchedule<T>(result[0]);
  }

  #listForOwner<T = string>(
    owner: LifecycleRouteAddress | null,
    criteria: ScheduleCriteria = {}
  ): Schedule<T>[] {
    let query = "SELECT * FROM cf_agents_schedules WHERE owner_path_key IS ?";
    const params: Array<string | number | null> = [owner?.key ?? null];

    if (criteria.id) {
      query += " AND id = ?";
      params.push(criteria.id);
    }
    if (criteria.type) {
      query += " AND type = ?";
      params.push(criteria.type);
    }
    if (criteria.timeRange) {
      query += " AND time >= ? AND time <= ?";
      const start = criteria.timeRange.start || new Date(0);
      const end = criteria.timeRange.end || new Date(999999999999999);
      params.push(
        Math.floor(start.getTime() / 1000),
        Math.floor(end.getTime() / 1000)
      );
    }

    return this.lifecycle.storage.sql
      .exec(query, ...params)
      .toArray()
      .map((row) =>
        // SAFETY: the query selects * from Scheduler's own schema.
        this.#rowToSchedule<T>(row as unknown as ScheduleStorageRow)
      );
  }

  async #cancelForOwner(
    owner: LifecycleRouteAddress | null,
    id: string
  ): Promise<{ ok: boolean; callback?: string }> {
    const ownerPathKey = owner?.key ?? null;
    const result = this.#sql<ScheduleStorageRow>`
      SELECT * FROM cf_agents_schedules
      WHERE id = ${id} AND owner_path_key IS ${ownerPathKey}
    `;
    if (result.length === 0) return { ok: false };

    const callback = result[0].callback;
    this.#sql`
      DELETE FROM cf_agents_schedules
      WHERE id = ${id} AND owner_path_key IS ${ownerPathKey}
    `;
    await this.lifecycle.alarms.rearm();
    return { ok: true, callback };
  }

  /** Cancel every owned row matched by a route-address predicate. */
  #cancelOwners(matches: (owner: LifecycleRouteAddress) => boolean): void {
    const rows = this.#sql<ScheduleStorageRow>`
      SELECT * FROM cf_agents_schedules
      WHERE owner_path IS NOT NULL
    `;
    for (const row of rows) {
      if (
        !row.owner_path ||
        !matches({
          key: row.owner_path_key ?? row.owner_path,
          data: row.owner_path
        })
      )
        continue;
      this.#emit("schedule:cancel", { callback: row.callback, id: row.id });
      this.#sql`DELETE FROM cf_agents_schedules WHERE id = ${row.id}`;
    }
  }

  /** Delete rows selected by a host-owned failure policy. Best-effort. */
  #deleteRows(callbacks: ReadonlyArray<string>, executingRowId?: string): void {
    for (const callback of callbacks) {
      try {
        this.#sql`
          DELETE FROM cf_agents_schedules WHERE callback = ${callback}
        `;
      } catch {
        // best-effort at a host failure boundary
      }
    }
    if (executingRowId) {
      try {
        this.#sql`
          DELETE FROM cf_agents_schedules WHERE id = ${executingRowId}
        `;
      } catch {
        // best-effort at a host failure boundary
      }
    }
  }

  /** Delay rows selected by a host-owned failure policy. Best-effort. */
  #moveRows(
    callbacks: ReadonlyArray<string>,
    executingRowId: string | undefined,
    nextTime: number
  ): void {
    for (const callback of callbacks) {
      try {
        this.#sql`
          UPDATE cf_agents_schedules
          SET time = ${nextTime}
          WHERE callback = ${callback} AND time <= ${nextTime}
        `;
      } catch {
        // best-effort at a host failure boundary
      }
    }
    if (executingRowId) {
      try {
        this.#sql`
          UPDATE cf_agents_schedules
          SET time = ${nextTime}
          WHERE id = ${executingRowId} AND time <= ${nextTime}
        `;
      } catch {
        // best-effort at a host failure boundary
      }
    }
  }

  // ── Execution ────────────────────────────────────────────────────────────

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

  /**
   * Execute a local schedule row with retry handling.
   *
   * The capability remains outside ambient context. Lifecycle's host-callback
   * boundary establishes host context only around user callback invocation.
   */
  async #executeCallback(row: ScheduleStorageRow): Promise<void> {
    if (!this.lifecycle.callbacks.has(row.callback)) {
      console.error(`callback ${row.callback} not found`);
      return;
    }

    const { maxAttempts, baseDelayMs, maxDelayMs } = resolveRetryConfig(
      parseRetryOptions(row),
      this.#retryDefaults
    );

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(row.payload);
    } catch (error) {
      console.error(
        `Failed to parse payload for schedule "${row.id}" (callback "${row.callback}")`,
        error
      );
      this.#emit("schedule:error", {
        callback: row.callback,
        id: row.id,
        error: error instanceof Error ? error.message : String(error),
        attempts: 0
      });
      return;
    }

    // A one-shot row is deleted by the alarm phase once this returns
    // normally. If it fails with a superseded-isolate error (a deploy / code
    // update replaced the isolate — "reset because its code was updated" or
    // "this script has been upgraded"), burning in-process retries is futile
    // (code never reloads mid-invocation) and swallowing the error would let
    // the alarm phase delete the row. Re-throw platform transients so the
    // durable alarm can retry the preserved row on a fresh invocation.
    const isOneShotSchedule =
      row.type === "delayed" || row.type === "scheduled";
    const shouldDeferReset = (error: unknown): boolean =>
      isOneShotSchedule && isDurableObjectCodeUpdateReset(error);
    const shouldDeferOnExhaustion = (error: unknown): boolean =>
      isOneShotSchedule && isPlatformTransientError(error);
    const shouldDeferMemoryLimit = (error: unknown): boolean =>
      isOneShotSchedule && isDurableObjectMemoryLimitReset(error);

    const schedule = this.#rowToSchedule<unknown>(row);

    try {
      this.#emit("schedule:execute", { callback: row.callback, id: row.id });

      await tryN(
        maxAttempts,
        async (attempt) => {
          if (attempt > 1) {
            this.#emit("schedule:retry", {
              callback: row.callback,
              id: row.id,
              attempt,
              maxAttempts
            });
          }
          await this.lifecycle.callbacks.invoke(row.callback, [
            parsedPayload,
            schedule
          ]);
        },
        {
          baseDelayMs,
          maxDelayMs,
          shouldRetry: (error) => !shouldDeferReset(error)
        }
      );
    } catch (error) {
      if (shouldDeferReset(error)) {
        console.warn(
          `Deferring scheduled callback "${row.callback}" to a fresh invocation after a Durable Object code-update reset; the one-shot row is preserved and the alarm will re-run on new code.`
        );
        throw error;
      }
      if (shouldDeferOnExhaustion(error)) {
        console.warn(
          `Deferring scheduled callback "${row.callback}" after exhausting in-process retries on a transient platform error; the one-shot row is preserved and the alarm will re-run once the platform recovers.`
        );
        throw error;
      }
      if (shouldDeferMemoryLimit(error)) {
        console.warn(
          `Deferring scheduled callback "${row.callback}" to the alarm memory-limit circuit breaker after a Durable Object memory-limit reset; the one-shot row is preserved so the breaker can bound the retry loop and seal it (#1825).`
        );
        throw error;
      }
      console.error(
        `error executing callback "${row.callback}" after ${maxAttempts} attempts`,
        error
      );
      this.#emit("schedule:error", {
        callback: row.callback,
        id: row.id,
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

  /** Execute every schedule row due in the current alarm phase. */
  async #fireDueSchedules(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const dueRows = this.#sql<ScheduleStorageRow>`
      SELECT * FROM cf_agents_schedules WHERE time <= ${now}
    `;
    this.#warnStaleOneShots(dueRows);

    for (const row of dueRows) {
      const outcome = await this.#runDueRow(row, now);
      if (outcome === "stop") return;
      if (outcome === "executed") this.#advanceRow(row);
    }
  }

  /**
   * Warn when many stale one-shot rows share the same callback — this
   * usually means schedule() was called repeatedly (e.g. in onStart)
   * without idempotent:true and rows accumulated across restarts.
   */
  #warnStaleOneShots(dueRows: ReadonlyArray<ScheduleStorageRow>): void {
    const DUPLICATE_SCHEDULE_THRESHOLD = 10;
    const oneShotCounts = new Map<string, number>();
    for (const row of dueRows) {
      if (row.type === "delayed" || row.type === "scheduled") {
        oneShotCounts.set(
          row.callback,
          (oneShotCounts.get(row.callback) ?? 0) + 1
        );
      }
    }
    for (const [callback, count] of oneShotCounts) {
      if (count < DUPLICATE_SCHEDULE_THRESHOLD) continue;
      try {
        console.warn(
          `Processing ${count} stale "${callback}" schedules in a single alarm cycle. ` +
            `This usually means schedule() is being called repeatedly without ` +
            `the idempotent option. Consider using scheduleEvery() for recurring ` +
            `tasks or passing { idempotent: true } to schedule().`
        );
        this.#emit("schedule:duplicate_warning", {
          callback,
          count,
          type: "one-shot"
        });
      } catch {
        // Warning emission is non-critical — never block row processing.
      }
    }
  }

  /**
   * Run one due row.
   *
   * @returns "executed" when the row ran and should advance, "skipped" when
   * it should be left for a later alarm cycle, and "stop" when host teardown
   * disabled further durable work mid-phase.
   */
  async #runDueRow(
    row: ScheduleStorageRow,
    now: number
  ): Promise<"executed" | "skipped" | "stop"> {
    // Overlap prevention for interval schedules with hung callback detection.
    if (row.type === "interval" && row.running === 1) {
      const elapsedSeconds = now - (row.execution_started_at ?? 0);
      if (elapsedSeconds < this.#hungScheduleTimeoutSeconds) {
        console.warn(
          `Skipping interval schedule ${row.id}: previous execution still running`
        );
        return "skipped";
      }
      // Previous execution appears hung; force reset and re-execute.
      console.warn(
        `Forcing reset of hung interval schedule ${row.id} (started ${elapsedSeconds}s ago)`
      );
    }

    if (row.type === "interval") {
      this.#sql`
        UPDATE cf_agents_schedules
        SET running = 1, execution_started_at = ${now}
        WHERE id = ${row.id}
      `;
    }

    let executed = false;
    if (row.owner_path) {
      try {
        executed = (await this.lifecycle.routes.to(
          { key: row.owner_path_key ?? row.owner_path, data: row.owner_path },
          { type: "dispatch", row } satisfies SchedulerRouteMessage
        )) as boolean;
      } catch (error) {
        console.error(
          `error dispatching scheduled callback "${row.callback}"`,
          error
        );
        this.#emit("schedule:error", {
          callback: row.callback,
          id: row.id,
          error: error instanceof Error ? error.message : String(error),
          attempts: 0
        });
        try {
          await this.#onError?.(error);
        } catch {
          // swallow onError errors
        }
        // Reset the in-flight flag for interval rows so the row doesn't stay
        // stuck in `running=1` when dispatch fails (for example, a transport
        // can no longer resolve its owner). The next alarm cycle will retry.
        if (row.type === "interval") {
          this.#sql`
            UPDATE cf_agents_schedules SET running = 0 WHERE id = ${row.id}
          `;
        }
        return "skipped";
      }
    } else {
      // Retain the row ID while callback execution can escape so a host
      // failure policy can target the exact looping row without owning
      // storage.
      this.#executingRowId = row.id;
      await this.#executeCallback(row);
      this.#executingRowId = undefined;
      executed = true;
    }

    // A callback may have destroyed the host; its storage is gone.
    if (this.lifecycle.alarms.disabled()) return "stop";
    return executed ? "executed" : "skipped";
  }

  /** Reschedule a recurring row or delete an executed one-shot row. */
  #advanceRow(row: ScheduleStorageRow): void {
    if (row.type === "cron") {
      const nextTimestamp = Math.floor(
        nextCronTimeMs(row.cron ?? "", Date.now()) / 1000
      );
      this.#sql`
        UPDATE cf_agents_schedules SET time = ${nextTimestamp} WHERE id = ${row.id}
      `;
    } else if (row.type === "interval") {
      const nextTimestamp =
        Math.floor(Date.now() / 1000) + (row.intervalSeconds ?? 0);
      this.#sql`
        UPDATE cf_agents_schedules
        SET running = 0, time = ${nextTimestamp}
        WHERE id = ${row.id}
      `;
    } else {
      this.#sql`
        DELETE FROM cf_agents_schedules WHERE id = ${row.id}
      `;
    }
  }

  // ── Alarm contribution ───────────────────────────────────────────────────

  /**
   * Earliest wall-clock time (ms) a schedule row is ready to execute,
   * clamped to the future, or `null` when no row qualifies.
   */
  #nextScheduleTimeMs(nowMs: number, hungCutoffSeconds: number): number | null {
    // Find the earliest schedule row that is safe to execute now, even if it
    // is already overdue. Overdue schedules can happen after a DO restart
    // because the SQLite row survives but the in-memory alarm does not.
    const readySchedules = this.#sql<{ time: number }>`
      SELECT time FROM cf_agents_schedules
      WHERE type != 'interval'
        OR running = 0
        OR coalesce(execution_started_at, 0) <= ${hungCutoffSeconds}
      ORDER BY time ASC
      LIMIT 1
    `;

    if (readySchedules.length > 0 && "time" in readySchedules[0]) {
      return Math.max(readySchedules[0].time * 1000, nowMs + 1);
    }
    return null;
  }

  /**
   * Wall-clock time (ms) at which the earliest still-running (not yet hung)
   * interval schedule crosses the hung timeout and must be re-checked, or
   * `null` when none is running.
   */
  #nextHungIntervalRecheckMs(hungCutoffSeconds: number): number | null {
    // Running interval schedules that are not hung yet still need a future
    // alarm so the runtime can re-check them once they cross the hung timeout.
    const recoveringIntervals = this.#sql<{
      execution_started_at: number | null;
    }>`
      SELECT execution_started_at FROM cf_agents_schedules
      WHERE type = 'interval'
        AND running = 1
        AND coalesce(execution_started_at, 0) > ${hungCutoffSeconds}
      ORDER BY execution_started_at ASC
      LIMIT 1
    `;

    const startedAt = recoveringIntervals[0]?.execution_started_at;
    if (startedAt !== null && startedAt !== undefined) {
      return (startedAt + this.#hungScheduleTimeoutSeconds) * 1000;
    }
    return null;
  }
}
