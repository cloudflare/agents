/**
 * Lifecycle scheduling primitive. Owns the `cf_agents_schedules` table,
 * callback retry policy, and due-row processing.
 *
 * Lifecycle combines Scheduler's next wake-up candidate with contributions
 * from other capabilities and the host before arming the Durable Object.
 */

import { parseCronExpression } from "cron-schedule";
import {
  LifecycleCapability,
  type LifecycleRouteContext
} from "../lifecycle/capability";
import {
  runInLifecycleHostContext,
  type LifecycleObject
} from "../lifecycle/current-agent";
import {
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
  isPlatformTransientError,
  tryN,
  validateRetryOptions
} from "../retries";
import type { RetryOptions } from "../retries";
import type {
  SchedulerEventType,
  SchedulerIntegration,
  SchedulerOptions,
  SchedulerOwner
} from "./options";
import type { Schedule, ScheduleCriteria, ScheduleStorageRow } from "./types";

function parseRetryOptions(
  row: Record<string, unknown>
): RetryOptions | undefined {
  return typeof row.retry_options === "string"
    ? (JSON.parse(row.retry_options) as RetryOptions)
    : undefined;
}

const SCHEDULE_SCHEMA_VERSION_KEY = "cf_agents:schedules_schema_version";
const CURRENT_SCHEDULE_SCHEMA_VERSION = 1;

type SchedulerRouteMessage =
  | {
      readonly type: "schedule";
      readonly when: Date | string | number;
      readonly callback: string;
      readonly payload?: unknown;
      readonly options?: { retry?: RetryOptions; idempotent?: boolean };
    }
  | {
      readonly type: "every";
      readonly intervalSeconds: number;
      readonly callback: string;
      readonly payload?: unknown;
      readonly options?: { retry?: RetryOptions; idempotent?: boolean };
    }
  | { readonly type: "get" | "cancel"; readonly id: string }
  | { readonly type: "list"; readonly criteria?: ScheduleCriteria }
  | { readonly type: "dispatch"; readonly row: ScheduleStorageRow };

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

function getNextCronTime(cron: string, now: number) {
  const interval = parseCronExpression(cron);
  return interval.getNextDate(new Date(now));
}

const schedulerIntegrationSetters = new WeakMap<
  object,
  (integration: SchedulerIntegration<LifecycleObject>) => void
>();

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 3000
};

function executeSql<T>(
  storage: DurableObjectStorage,
  strings: TemplateStringsArray,
  values: (string | number | boolean | null)[]
): T[] {
  const query = strings.reduce(
    (result, part, index) => result + part + (index < values.length ? "?" : ""),
    ""
  );
  return [...storage.sql.exec(query, ...values)] as T[];
}

function createStandaloneIntegration<Host extends LifecycleObject>(
  target: Host,
  storage: DurableObjectStorage,
  options: SchedulerOptions,
  rearm: () => void | Promise<void>
): SchedulerIntegration<Host> {
  // SAFETY: Scheduler callback names are persisted string keys. Runtime checks
  // below narrow each lookup to a function before it is invoked.
  const callbacks = target as unknown as Record<string, unknown>;
  if (options.retry) validateRetryOptions(options.retry, DEFAULT_RETRY);
  const retryDefaults: Required<RetryOptions> = {
    maxAttempts: options.retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
    baseDelayMs: options.retry?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
    maxDelayMs: options.retry?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs
  };

  return {
    host: target,
    storage,
    now: Date.now,
    createId: () => crypto.randomUUID(),
    sql: <T>(
      strings: TemplateStringsArray,
      ...values: (string | number | boolean | null)[]
    ) => executeSql<T>(storage, strings, values),
    rawSql: (query, ...params) => storage.sql.exec(query, ...params),
    retryDefaults: () => retryDefaults,
    hungScheduleTimeoutSeconds: () => options.hungScheduleTimeoutSeconds ?? 30,
    validateSchedule: (when, callback, scheduleOptions) => {
      if (typeof callback !== "string") {
        throw new Error("Callback must be a string");
      }
      if (typeof callbacks[callback] !== "function") {
        throw new Error(`callbacks.${callback} is not a function`);
      }
      if (scheduleOptions?.retry) {
        validateRetryOptions(scheduleOptions.retry, retryDefaults);
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
    },
    hasCallback: (callback) => typeof callbacks[callback] === "function",
    invokeCallback: (callback, payload, schedule) => {
      const method = callbacks[callback];
      if (typeof method !== "function") {
        throw new Error(`callbacks.${callback} is not a function`);
      }
      return runInLifecycleHostContext({ host: target }, () =>
        (
          method as (
            payload: unknown,
            schedule: Schedule<unknown>
          ) => void | Promise<void>
        ).call(target, payload, schedule)
      );
    },
    rearm,
    isDestroyed: () => false,
    onError: (error) => options.onError?.(error)
  };
}

/**
 * Persistent task scheduling for a Lifecycle Object.
 *
 * Install the same instance with `Lifecycle.use()`. Scheduler owns its SQL
 * schema, task CRUD, callback retries, and due-row processing. It contributes
 * its next wake time while Lifecycle owns the physical alarm.
 */
export class Scheduler<
  Host extends LifecycleObject = LifecycleObject
> extends LifecycleCapability {
  private _host: SchedulerIntegration<Host> | undefined;
  private _executingScheduleRowId?: string;
  private _schemaReady = false;

  /** Create a persistent Scheduler targeting named methods on this object. */
  constructor(
    private readonly _target: Host,
    private readonly _options: SchedulerOptions = {}
  ) {
    super("scheduler");

    schedulerIntegrationSetters.set(this, (integration) => {
      // SAFETY: createScheduler passes the same Host type used to construct this
      // Scheduler; the WeakMap erases that generic only at the package boundary.
      this._host = integration as SchedulerIntegration<Host>;
    });
  }

  #host(): SchedulerIntegration<Host> {
    if (!this._host) {
      this._host = createStandaloneIntegration(
        this._target,
        this.lifecycle.storage,
        this._options,
        this.lifecycle.alarms.rearm
      );
    }
    return this._host;
  }

  #emit(type: SchedulerEventType, payload: Record<string, unknown>): void {
    this.lifecycle.events.emit(type, payload);
  }

  /** Handle Scheduler protocol messages routed by another Lifecycle. */
  async onRoute(context: LifecycleRouteContext): Promise<unknown> {
    const message = context.payload as SchedulerRouteMessage;
    const owner = context.source
      ? { key: context.source.key, data: context.source.data }
      : null;
    switch (message.type) {
      case "schedule":
        return this.insertForOwner(
          owner,
          message.when,
          message.callback,
          message.payload,
          message.options
        );
      case "every":
        return this.insertIntervalForOwner(
          owner,
          message.intervalSeconds,
          message.callback,
          message.payload,
          message.options
        );
      case "get":
        return this.getForOwner(owner, message.id);
      case "list":
        return this.listForOwner(owner, message.criteria);
      case "cancel":
        return this.cancelForOwner(owner, message.id);
      case "dispatch":
        await this.executeCallback(message.row);
        return true;
      default:
        throw new Error("Unknown routed Scheduler message");
    }
  }

  /** Initialize and migrate schedule storage during Lifecycle startup. */
  async onStart(): Promise<void> {
    const version =
      (await this.#host().storage.get<number>(SCHEDULE_SCHEMA_VERSION_KEY)) ??
      0;
    if (version >= CURRENT_SCHEDULE_SCHEMA_VERSION) return;

    if (!this._schemaReady) this.ensureSchema();
    await this.#host().storage.put(
      SCHEDULE_SCHEMA_VERSION_KEY,
      CURRENT_SCHEDULE_SCHEMA_VERSION
    );
  }

  /** @internal Re-run the idempotent schedule schema migration. */
  private ensureSchema(): void {
    this.#host().rawSql(`
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
        this.#host().rawSql(statement);
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

    const rows = this.#host()
      .rawSql<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='cf_agents_schedules'"
      )
      .toArray();
    const ddl = rows[0]?.sql ?? "";
    if (ddl && !ddl.includes("'interval'")) {
      this.#host().rawSql("DROP TABLE IF EXISTS cf_agents_schedules_new");
      this.#host().rawSql(`
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
      this.#host().rawSql(`
        INSERT INTO cf_agents_schedules_new
          (id, callback, payload, type, time, delayInSeconds, cron,
           intervalSeconds, running, created_at, execution_started_at,
           retry_options, owner_path, owner_path_key)
        SELECT id, callback, payload, type, time, delayInSeconds, cron,
               intervalSeconds, running, created_at, execution_started_at,
               retry_options, owner_path, owner_path_key
        FROM cf_agents_schedules
      `);
      this.#host().rawSql("DROP TABLE cf_agents_schedules");
      this.#host().rawSql(
        "ALTER TABLE cf_agents_schedules_new RENAME TO cf_agents_schedules"
      );
    }

    // Keep-alive no longer uses schedule rows. Remove orphaned heartbeat rows
    // left by older Scheduler versions.
    this.#host().rawSql(
      "DELETE FROM cf_agents_schedules WHERE callback = '_cf_keepAliveHeartbeat'"
    );
    this._schemaReady = true;
  }

  /** Execute due schedule rows during the Lifecycle alarm phase. */
  async onAlarm(): Promise<void> {
    await this.fireDueSchedules();
  }

  /** @internal Consume the row ID retained when callback execution escaped. */
  private takeExecutingScheduleRowId(): string | undefined {
    const id = this._executingScheduleRowId;
    this._executingScheduleRowId = undefined;
    return id;
  }

  /** @internal Delete rows selected by a host-owned failure policy. */
  private deleteRows(
    callbacks: ReadonlyArray<string>,
    executingRowId?: string
  ): void {
    for (const callback of callbacks) {
      try {
        this.#host().sql`
          DELETE FROM cf_agents_schedules WHERE callback = ${callback}
        `;
      } catch {
        // best-effort at a host failure boundary
      }
    }
    if (executingRowId) {
      try {
        this.#host().sql`
          DELETE FROM cf_agents_schedules WHERE id = ${executingRowId}
        `;
      } catch {
        // best-effort at a host failure boundary
      }
    }
  }

  /** @internal Move rows selected by a host-owned failure policy. */
  private moveRows(
    callbacks: ReadonlyArray<string>,
    executingRowId: string | undefined,
    nextTime: number
  ): void {
    for (const callback of callbacks) {
      try {
        this.#host().sql`
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
        this.#host().sql`
          UPDATE cf_agents_schedules
          SET time = ${nextTime}
          WHERE id = ${executingRowId} AND time <= ${nextTime}
        `;
      } catch {
        // best-effort at a host failure boundary
      }
    }
  }

  /** Schedule a delayed, dated, or cron callback. */
  async schedule<T = string>(
    when: Date | string | number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<Schedule<T>> {
    await this.lifecycle.ready();
    this.#host().validateSchedule(when, callback, options);
    const result = this.lifecycle.routes.source
      ? ((await this.lifecycle.routes.toRoot({
          type: "schedule",
          when,
          callback,
          payload,
          options
        } satisfies SchedulerRouteMessage)) as {
          schedule: Schedule<T>;
          created: boolean;
        })
      : await this.insertForOwner(null, when, callback, payload, options);
    if (result.created) {
      this.#emit("schedule:create", {
        callback: result.schedule.callback,
        id: result.schedule.id
      });
    }
    return result.schedule;
  }

  /** Set a delayed, dated, or cron callback on this Scheduler's target. */
  set<
    Name extends keyof Host,
    Method extends Extract<Host[Name], (...args: never[]) => unknown>
  >(
    when: Date | string | number,
    callback: Name,
    payload: Parameters<Method>[0],
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<Schedule<Parameters<Method>[0]>> {
    return this.schedule(when, callback as string, payload, options) as Promise<
      Schedule<Parameters<Method>[0]>
    >;
  }

  /** Schedule a callback at a fixed interval. */
  async scheduleEvery<T = string>(
    intervalSeconds: number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<Schedule<T>> {
    await this.lifecycle.ready();
    this.validateIntervalSchedule(intervalSeconds, callback, options?.retry);
    const result = this.lifecycle.routes.source
      ? ((await this.lifecycle.routes.toRoot({
          type: "every",
          intervalSeconds,
          callback,
          payload,
          options
        } satisfies SchedulerRouteMessage)) as {
          schedule: Schedule<T>;
          created: boolean;
        })
      : await this.insertIntervalForOwner(
          null,
          intervalSeconds,
          callback,
          payload,
          options
        );
    if (result.created) {
      this.#emit("schedule:create", {
        callback: result.schedule.callback,
        id: result.schedule.id
      });
    }
    return result.schedule;
  }

  /** Set a fixed-interval callback on this Scheduler's target. */
  every<
    Name extends keyof Host,
    Method extends Extract<Host[Name], (...args: never[]) => unknown>
  >(
    intervalSeconds: number,
    callback: Name,
    payload: Parameters<Method>[0],
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<Schedule<Parameters<Method>[0]>> {
    return this.scheduleEvery(
      intervalSeconds,
      callback as string,
      payload,
      options
    ) as Promise<Schedule<Parameters<Method>[0]>>;
  }

  /** Get a schedule by ID. */
  getSchedule<T = string>(id: string): Schedule<T> | undefined {
    if (this.lifecycle.routes.source) {
      throw new Error(
        "getSchedule() is synchronous and cannot read routed schedule storage. " +
          "Use await scheduler.get(id) instead."
      );
    }
    return this.getForOwner(null, id);
  }

  /** Get a schedule by ID through an asynchronous-compatible API. */
  async getScheduleById(id: string): Promise<Schedule<unknown> | undefined> {
    await this.lifecycle.ready();
    return this.lifecycle.routes.source
      ? ((await this.lifecycle.routes.toRoot({
          type: "get",
          id
        } satisfies SchedulerRouteMessage)) as Schedule<unknown> | undefined)
      : this.getForOwner(null, id);
  }

  /** Get a schedule through the primary asynchronous API. */
  get(id: string): Promise<Schedule<unknown> | undefined> {
    return this.getScheduleById(id);
  }

  /** List schedules matching criteria. */
  getSchedules<T = string>(criteria: ScheduleCriteria = {}): Schedule<T>[] {
    if (this.lifecycle.routes.source) {
      throw new Error(
        "getSchedules() is synchronous and cannot read routed schedule storage. " +
          "Use await scheduler.list(criteria) instead."
      );
    }
    return this.listForOwner(null, criteria);
  }

  /** List schedules through an asynchronous-compatible API. */
  async listSchedules(
    criteria: ScheduleCriteria = {}
  ): Promise<Schedule<unknown>[]> {
    await this.lifecycle.ready();
    return this.lifecycle.routes.source
      ? ((await this.lifecycle.routes.toRoot({
          type: "list",
          criteria
        } satisfies SchedulerRouteMessage)) as Schedule<unknown>[])
      : this.listForOwner(null, criteria);
  }

  /** List schedules through the primary asynchronous API. */
  list(criteria: ScheduleCriteria = {}): Promise<Schedule<unknown>[]> {
    return this.listSchedules(criteria);
  }

  /** Cancel one schedule owned by this Scheduler. */
  async cancelSchedule(id: string): Promise<boolean> {
    await this.lifecycle.ready();
    const result = this.lifecycle.routes.source
      ? ((await this.lifecycle.routes.toRoot({
          type: "cancel",
          id
        } satisfies SchedulerRouteMessage)) as {
          ok: boolean;
          callback?: string;
        })
      : await this.cancelForOwner(null, id);
    if (result.ok && result.callback) {
      this.#emit("schedule:cancel", {
        callback: result.callback,
        id
      });
    }
    return result.ok;
  }

  /** Cancel a schedule through the primary API. */
  cancel(id: string): Promise<boolean> {
    return this.cancelSchedule(id);
  }

  /** @internal Remove rows owned by one routed Lifecycle subtree. */
  cleanupRoutePrefix(prefix: string): void {
    this.cancelOwners(
      (owner) => owner.key === prefix || owner.key.startsWith(`${prefix}/`)
    );
  }

  /** @internal Apply Agent's outer alarm memory-limit policy to Scheduler rows. */
  handleAlarmMemoryLimit(options: {
    readonly callbacks: ReadonlyArray<string>;
    readonly sealed: boolean;
    readonly nextTime?: number;
  }): void {
    const executingRowId = this.takeExecutingScheduleRowId();
    if (options.sealed) {
      this.deleteRows(options.callbacks, executingRowId);
      return;
    }
    if (options.nextTime === undefined) {
      throw new Error("Scheduler memory-limit backoff requires nextTime");
    }
    this.moveRows(options.callbacks, executingRowId, options.nextTime);
  }

  /** @internal Validate an interval before a host adapter persists it. */
  private validateIntervalSchedule(
    intervalSeconds: number,
    callback: string,
    retry?: RetryOptions
  ): void {
    const maxIntervalSeconds = 30 * 24 * 60 * 60;
    if (typeof intervalSeconds !== "number" || intervalSeconds <= 0) {
      throw new Error("intervalSeconds must be a positive number");
    }
    if (intervalSeconds > maxIntervalSeconds) {
      throw new Error(
        `intervalSeconds cannot exceed ${maxIntervalSeconds} seconds (30 days)`
      );
    }
    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }
    if (!this.#host().hasCallback(callback)) {
      throw new Error(`this.${callback} is not a function`);
    }
    if (retry) validateRetryOptions(retry, this.#host().retryDefaults());
  }

  /**
   * Insert (or, for idempotent calls, return the existing row for) a
   * schedule owned locally (`owner === null`) or by an opaque host adapter.
   * Returns `{ schedule, created }` — `created`
   * is `false` when an idempotent insert deduplicates onto an existing
   * row, so callers can suppress the `schedule:create` event in that
   * case to match historic semantics.
   */
  private async insertForOwner<T = string>(
    owner: SchedulerOwner | null,
    when: Date | string | number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    const ownerPathJson = owner?.data ?? null;
    const ownerPathKey = owner?.key ?? null;
    const retryJson = options?.retry ? JSON.stringify(options.retry) : null;
    const payloadJson = JSON.stringify(payload);

    if (when instanceof Date) {
      const timestamp = Math.floor(when.getTime() / 1000);

      if (options?.idempotent) {
        const existing = this.#host().sql<ScheduleStorageRow>`
          SELECT * FROM cf_agents_schedules
          WHERE type = 'scheduled'
            AND callback = ${callback}
            AND payload IS ${payloadJson}
            AND owner_path_key IS ${ownerPathKey}
          LIMIT 1
        `;

        if (existing.length > 0) {
          const row = existing[0];
          await this.#host().rearm();
          return {
            schedule: {
              callback: row.callback,
              id: row.id,
              payload: JSON.parse(row.payload) as T,
              retry: parseRetryOptions(
                row as unknown as Record<string, unknown>
              ),
              time: row.time,
              type: "scheduled"
            },
            created: false
          };
        }
      }

      const id = this.#host().createId();
      this.#host().sql`
        INSERT OR REPLACE INTO cf_agents_schedules
          (id, callback, payload, type, time, retry_options, owner_path, owner_path_key)
        VALUES
          (${id}, ${callback}, ${payloadJson}, 'scheduled', ${timestamp}, ${retryJson}, ${ownerPathJson}, ${ownerPathKey})
      `;

      await this.#host().rearm();
      return {
        schedule: {
          callback,
          id,
          payload: payload as T,
          retry: options?.retry,
          time: timestamp,
          type: "scheduled"
        },
        created: true
      };
    }

    if (typeof when === "number") {
      const timestamp = Math.floor((this.#host().now() + when * 1000) / 1000);

      if (options?.idempotent) {
        const existing = this.#host().sql<ScheduleStorageRow>`
          SELECT * FROM cf_agents_schedules
          WHERE type = 'delayed'
            AND callback = ${callback}
            AND payload IS ${payloadJson}
            AND owner_path_key IS ${ownerPathKey}
          LIMIT 1
        `;

        if (existing.length > 0) {
          const row = existing[0];
          await this.#host().rearm();
          return {
            schedule: {
              callback: row.callback,
              delayInSeconds: row.delayInSeconds ?? 0,
              id: row.id,
              payload: JSON.parse(row.payload) as T,
              retry: parseRetryOptions(
                row as unknown as Record<string, unknown>
              ),
              time: row.time,
              type: "delayed"
            },
            created: false
          };
        }
      }

      const id = this.#host().createId();
      this.#host().sql`
        INSERT OR REPLACE INTO cf_agents_schedules
          (id, callback, payload, type, delayInSeconds, time, retry_options, owner_path, owner_path_key)
        VALUES
          (${id}, ${callback}, ${payloadJson}, 'delayed', ${when}, ${timestamp}, ${retryJson}, ${ownerPathJson}, ${ownerPathKey})
      `;

      await this.#host().rearm();
      return {
        schedule: {
          callback,
          delayInSeconds: when,
          id,
          payload: payload as T,
          retry: options?.retry,
          time: timestamp,
          type: "delayed"
        },
        created: true
      };
    }

    if (typeof when === "string") {
      const timestamp = Math.floor(
        getNextCronTime(when, this.#host().now()).getTime() / 1000
      );
      const idempotent = options?.idempotent !== false;

      if (idempotent) {
        const existing = this.#host().sql<ScheduleStorageRow>`
          SELECT * FROM cf_agents_schedules
          WHERE type = 'cron'
            AND callback = ${callback}
            AND cron = ${when}
            AND payload IS ${payloadJson}
            AND owner_path_key IS ${ownerPathKey}
          LIMIT 1
        `;

        if (existing.length > 0) {
          const row = existing[0];
          await this.#host().rearm();
          return {
            schedule: {
              callback: row.callback,
              cron: row.cron ?? when,
              id: row.id,
              payload: JSON.parse(row.payload) as T,
              retry: parseRetryOptions(
                row as unknown as Record<string, unknown>
              ),
              time: row.time,
              type: "cron"
            },
            created: false
          };
        }
      }

      const id = this.#host().createId();
      this.#host().sql`
        INSERT OR REPLACE INTO cf_agents_schedules
          (id, callback, payload, type, cron, time, retry_options, owner_path, owner_path_key)
        VALUES
          (${id}, ${callback}, ${payloadJson}, 'cron', ${when}, ${timestamp}, ${retryJson}, ${ownerPathJson}, ${ownerPathKey})
      `;

      await this.#host().rearm();
      return {
        schedule: {
          callback,
          cron: when,
          id,
          payload: payload as T,
          retry: options?.retry,
          time: timestamp,
          type: "cron"
        },
        created: true
      };
    }

    throw new Error(
      `Invalid schedule type: ${JSON.stringify(when)}(${typeof when}) trying to schedule ${callback}`
    );
  }

  /**
   * Insert (or, for idempotent calls, return the existing row for) an
   * interval schedule. Mirrors {@link insertForOwner} — returns
   * `{ schedule, created }` so callers can suppress `schedule:create`
   * on dedup.
   */
  private async insertIntervalForOwner<T = string>(
    owner: SchedulerOwner | null,
    intervalSeconds: number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    const ownerPathJson = owner?.data ?? null;
    const ownerPathKey = owner?.key ?? null;
    const idempotent = options?.idempotent !== false;
    const payloadJson = JSON.stringify(payload);

    if (idempotent) {
      const existing = this.#host().sql<ScheduleStorageRow>`
        SELECT * FROM cf_agents_schedules
        WHERE type = 'interval'
          AND callback = ${callback}
          AND intervalSeconds = ${intervalSeconds}
          AND payload IS ${payloadJson}
          AND owner_path_key IS ${ownerPathKey}
        LIMIT 1
      `;

      if (existing.length > 0) {
        const row = existing[0];
        await this.#host().rearm();
        return {
          schedule: {
            callback: row.callback,
            id: row.id,
            intervalSeconds: row.intervalSeconds ?? intervalSeconds,
            payload: JSON.parse(row.payload) as T,
            retry: parseRetryOptions(row as unknown as Record<string, unknown>),
            time: row.time,
            type: "interval"
          },
          created: false
        };
      }
    }

    const id = this.#host().createId();
    const timestamp = Math.floor(
      (this.#host().now() + intervalSeconds * 1000) / 1000
    );
    const retryJson = options?.retry ? JSON.stringify(options.retry) : null;

    this.#host().sql`
      INSERT OR REPLACE INTO cf_agents_schedules
        (id, callback, payload, type, intervalSeconds, time, running, retry_options, owner_path, owner_path_key)
      VALUES
        (${id}, ${callback}, ${payloadJson}, 'interval', ${intervalSeconds}, ${timestamp}, 0, ${retryJson}, ${ownerPathJson}, ${ownerPathKey})
    `;

    await this.#host().rearm();
    return {
      schedule: {
        callback,
        id,
        intervalSeconds,
        payload: payload as T,
        retry: options?.retry,
        time: timestamp,
        type: "interval"
      },
      created: true
    };
  }

  /** @internal Cancel a row belonging to an opaque host-owned identity. */
  private async cancelForOwner(
    owner: SchedulerOwner | null,
    id: string
  ): Promise<{ ok: boolean; callback?: string }> {
    const ownerPathKey = owner?.key ?? null;
    const result = this.#host().sql<ScheduleStorageRow>`
      SELECT * FROM cf_agents_schedules
      WHERE id = ${id} AND owner_path_key IS ${ownerPathKey}
    `;
    if (result.length === 0) return { ok: false };

    const callback = result[0].callback;
    this.#host().sql`
      DELETE FROM cf_agents_schedules
      WHERE id = ${id} AND owner_path_key IS ${ownerPathKey}
    `;
    await this.#host().rearm();
    return { ok: true, callback };
  }

  /** @internal Cancel opaque owner rows selected by a host adapter. */
  private cancelOwners(matches: (owner: SchedulerOwner) => boolean): void {
    const rows = this.#host().sql<ScheduleStorageRow>`
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
      this.#emit("schedule:cancel", {
        callback: row.callback,
        id: row.id
      });
      this.#host().sql`DELETE FROM cf_agents_schedules WHERE id = ${row.id}`;
    }
  }

  private rowToSchedule<T>(row: ScheduleStorageRow): Schedule<T> {
    const base = {
      callback: row.callback,
      id: row.id,
      payload: JSON.parse(row.payload) as T,
      retry: parseRetryOptions(row as unknown as Record<string, unknown>)
    };

    switch (row.type) {
      case "scheduled":
        return {
          ...base,
          time: row.time,
          type: "scheduled"
        };
      case "delayed":
        return {
          ...base,
          delayInSeconds: row.delayInSeconds ?? 0,
          time: row.time,
          type: "delayed"
        };
      case "cron":
        return {
          ...base,
          cron: row.cron ?? "",
          time: row.time,
          type: "cron"
        };
      case "interval":
        return {
          ...base,
          intervalSeconds: row.intervalSeconds ?? 0,
          time: row.time,
          type: "interval"
        };
    }
  }

  /** Read a single schedule row for the given owner. */
  private getForOwner<T = string>(
    owner: SchedulerOwner | null,
    id: string
  ): Schedule<T> | undefined {
    const ownerPathKey = owner?.key ?? null;
    const result = this.#host().sql<ScheduleStorageRow>`
      SELECT * FROM cf_agents_schedules
      WHERE id = ${id} AND owner_path_key IS ${ownerPathKey}
    `;
    if (!result || result.length === 0) {
      return undefined;
    }
    return this.rowToSchedule<T>(result[0]);
  }

  /** List schedule rows for the given owner, filtered by criteria. */
  private listForOwner<T = string>(
    owner: SchedulerOwner | null,
    criteria: ScheduleCriteria = {}
  ): Schedule<T>[] {
    const ownerPathKey = owner?.key ?? null;
    let query = "SELECT * FROM cf_agents_schedules WHERE owner_path_key IS ?";
    const params: Array<string | number | null> = [ownerPathKey];

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

    return this.#host()
      .rawSql(query, ...params)
      .toArray()
      .map((row) =>
        this.rowToSchedule<T>(row as unknown as ScheduleStorageRow)
      );
  }

  /**
   * Execute a local schedule row with retry handling.
   *
   * The capability remains outside ambient context. The callback adapter
   * establishes Lifecycle Object context only around user callback invocation.
   */
  private async executeCallback(row: ScheduleStorageRow): Promise<void> {
    if (!this.#host().hasCallback(row.callback)) {
      console.error(`callback ${row.callback} not found`);
      return;
    }

    const retryOpts = parseRetryOptions(
      row as unknown as Record<string, unknown>
    );
    const { maxAttempts, baseDelayMs, maxDelayMs } = resolveRetryConfig(
      retryOpts,
      this.#host().retryDefaults()
    );

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(row.payload as string);
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

    // A one-shot row is deleted by `alarm()` once this returns normally.
    // If it fails with a superseded-isolate error (a deploy / code update
    // replaced the isolate — "reset because its code was updated" or "this
    // script has been upgraded"), burning in-process retries is futile
    // (code never reloads mid-invocation) and swallowing the error would let
    // `alarm()` delete the row. Re-throw platform transients so the durable
    // alarm can retry the preserved row on a fresh invocation.
    const isOneShotSchedule =
      row.type === "delayed" || row.type === "scheduled";
    const shouldDeferReset = (error: unknown): boolean =>
      isOneShotSchedule && isDurableObjectCodeUpdateReset(error);
    const shouldDeferOnExhaustion = (error: unknown): boolean =>
      isOneShotSchedule && isPlatformTransientError(error);
    const shouldDeferMemoryLimit = (error: unknown): boolean =>
      isOneShotSchedule && isDurableObjectMemoryLimitReset(error);

    const schedule = this.rowToSchedule<unknown>(row);

    try {
      this.#emit("schedule:execute", {
        callback: row.callback,
        id: row.id
      });

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
          await this.#host().invokeCallback(
            row.callback,
            parsedPayload,
            schedule
          );
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
        await this.#host().onError(error);
      } catch {
        // swallow onError errors
      }
    }
  }

  /** Execute every schedule row due in the current Lifecycle alarm phase. */
  private async fireDueSchedules(): Promise<void> {
    const now = Math.floor(this.#host().now() / 1000);

    // Get all schedules that should be executed now
    const result = this.#host().sql<ScheduleStorageRow>`
      SELECT * FROM cf_agents_schedules WHERE time <= ${now}
    `;

    if (result && Array.isArray(result)) {
      // Warn when many stale one-shot rows share the same callback — this
      // usually means schedule() was called repeatedly (e.g. in onStart)
      // without idempotent:true and rows accumulated across restarts.
      const DUPLICATE_SCHEDULE_THRESHOLD = 10;
      const oneShotCounts = new Map<string, number>();
      for (const row of result) {
        if (row.type === "delayed" || row.type === "scheduled") {
          oneShotCounts.set(
            row.callback,
            (oneShotCounts.get(row.callback) ?? 0) + 1
          );
        }
      }
      for (const [cb, count] of oneShotCounts) {
        if (count >= DUPLICATE_SCHEDULE_THRESHOLD) {
          try {
            console.warn(
              `Processing ${count} stale "${cb}" schedules in a single alarm cycle. ` +
                `This usually means schedule() is being called repeatedly without ` +
                `the idempotent option. Consider using scheduleEvery() for recurring ` +
                `tasks or passing { idempotent: true } to schedule().`
            );
            this.#emit("schedule:duplicate_warning", {
              callback: cb,
              count,
              type: "one-shot"
            });
          } catch {
            // Warning emission is non-critical — never block row processing.
          }
        }
      }

      for (const row of result as ScheduleStorageRow[]) {
        let executed = false;

        // Overlap prevention for interval schedules with hung callback detection
        if (row.type === "interval" && row.running === 1) {
          const executionStartedAt =
            (row as { execution_started_at?: number }).execution_started_at ??
            0;
          const hungTimeoutSeconds = this.#host().hungScheduleTimeoutSeconds();
          const elapsedSeconds = now - executionStartedAt;

          if (elapsedSeconds < hungTimeoutSeconds) {
            console.warn(
              `Skipping interval schedule ${row.id}: previous execution still running`
            );
            continue;
          }
          // Previous execution appears hung, force reset and re-execute
          console.warn(
            `Forcing reset of hung interval schedule ${row.id} (started ${elapsedSeconds}s ago)`
          );
        }

        // Mark interval as running before execution
        if (row.type === "interval") {
          this.#host()
            .sql`UPDATE cf_agents_schedules SET running = 1, execution_started_at = ${now} WHERE id = ${row.id}`;
        }

        if (row.owner_path) {
          try {
            executed = (await this.lifecycle.routes.to(
              {
                key: row.owner_path_key ?? row.owner_path,
                data: row.owner_path
              },
              { type: "dispatch", row } satisfies SchedulerRouteMessage
            )) as boolean;
          } catch (e) {
            console.error(
              `error dispatching scheduled callback "${row.callback}"`,
              e
            );
            this.#emit("schedule:error", {
              callback: row.callback,
              id: row.id,
              error: e instanceof Error ? e.message : String(e),
              attempts: 0
            });
            try {
              await this.#host().onError(e);
            } catch {
              // swallow onError errors
            }
            // Reset the in-flight flag for interval rows so the row
            // doesn't stay stuck in `running=1` when dispatch fails
            // (for example, an adapter can no longer resolve its owner). The
            // next alarm cycle will retry.
            if (row.type === "interval") {
              this.#host().sql`
                UPDATE cf_agents_schedules SET running = 0 WHERE id = ${row.id}
              `;
            }
            continue;
          }
        } else {
          // Retain the row ID when callback execution escapes so a host failure
          // policy can target the exact looping row without owning storage.
          this._executingScheduleRowId = row.id;
          await this.executeCallback(row);
          this._executingScheduleRowId = undefined;
          executed = true;
        }

        if (this.#host().isDestroyed()) return;
        if (!executed) continue;

        if (row.type === "cron") {
          // Update next execution time for cron schedules
          const nextExecutionTime = getNextCronTime(
            row.cron ?? "",
            this.#host().now()
          );
          const nextTimestamp = Math.floor(nextExecutionTime.getTime() / 1000);

          this.#host().sql`
            UPDATE cf_agents_schedules SET time = ${nextTimestamp} WHERE id = ${row.id}
          `;
        } else if (row.type === "interval") {
          // Reset running flag and schedule next interval execution
          const nextTimestamp =
            Math.floor(this.#host().now() / 1000) + (row.intervalSeconds ?? 0);

          this.#host().sql`
            UPDATE cf_agents_schedules SET running = 0, time = ${nextTimestamp} WHERE id = ${row.id}
          `;
        } else {
          // Delete one-time schedules after execution
          this.#host().sql`
            DELETE FROM cf_agents_schedules WHERE id = ${row.id}
          `;
        }
      }
    }
  }

  /** Contribute the earliest pending schedule to Lifecycle alarm selection. */
  getNextAlarm(): number | null {
    const nowMs = this.#host().now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const hungCutoffSeconds =
      nowSeconds - this.#host().hungScheduleTimeoutSeconds();
    const nextSchedule = this.nextScheduleTimeMs(nowMs, hungCutoffSeconds);
    const hungIntervalRecheck =
      this.nextHungIntervalRecheckMs(hungCutoffSeconds);
    if (nextSchedule === null) return hungIntervalRecheck;
    if (hungIntervalRecheck === null) return nextSchedule;
    return Math.min(nextSchedule, hungIntervalRecheck);
  }

  /**
   * Earliest wall-clock time (ms) a schedule row is ready to execute,
   * clamped to the future, or `null` when no row qualifies. Coordinated
   * hosts include this candidate when selecting their shared physical alarm.
   */
  private nextScheduleTimeMs(
    nowMs: number,
    hungCutoffSeconds: number
  ): number | null {
    // Find the earliest schedule row that is safe to execute now, even if it
    // is already overdue. Overdue schedules can happen after a DO restart
    // because the SQLite row survives but the in-memory alarm does not.
    const readySchedules = this.#host().sql<{
      time: number;
    }>`
      SELECT time FROM cf_agents_schedules
      WHERE type != 'interval'
        OR running = 0
        OR coalesce(execution_started_at, 0) <= ${hungCutoffSeconds}
      ORDER BY time ASC
      LIMIT 1
    `;

    if (readySchedules.length > 0 && "time" in readySchedules[0]) {
      return Math.max((readySchedules[0].time as number) * 1000, nowMs + 1);
    }
    return null;
  }

  /**
   * Wall-clock time (ms) at which the earliest still-running (not yet
   * hung) interval schedule crosses the hung timeout and must be
   * re-checked, or `null` when none is running.
   */
  private nextHungIntervalRecheckMs(hungCutoffSeconds: number): number | null {
    // Running interval schedules that are not hung yet still need a future
    // alarm so the runtime can re-check them once they cross the hung timeout.
    const recoveringIntervals = this.#host().sql<{
      execution_started_at: number | null;
    }>`
      SELECT execution_started_at FROM cf_agents_schedules
      WHERE type = 'interval'
        AND running = 1
        AND coalesce(execution_started_at, 0) > ${hungCutoffSeconds}
      ORDER BY execution_started_at ASC
      LIMIT 1
    `;

    if (
      recoveringIntervals.length > 0 &&
      recoveringIntervals[0].execution_started_at !== null
    ) {
      return (
        (recoveringIntervals[0].execution_started_at +
          this.#host().hungScheduleTimeoutSeconds()) *
        1000
      );
    }
    return null;
  }
}

/** @internal Construct a Scheduler with a host integration adapter. */
export function createScheduler<Host extends LifecycleObject>(
  target: Host,
  options: SchedulerOptions,
  integration: SchedulerIntegration<Host>
): Scheduler<Host> {
  const scheduler = new Scheduler(target, options);
  const setIntegration = schedulerIntegrationSetters.get(scheduler);
  if (!setIntegration) throw new Error("Scheduler integration is unavailable");
  // SAFETY: Scheduler and integration share Host at this package boundary.
  setIntegration(integration as SchedulerIntegration<LifecycleObject>);
  return scheduler;
}
