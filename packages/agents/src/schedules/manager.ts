/**
 * Scheduling capability (Layer 1). Owns the `cf_agents_schedules` table.
 *
 * The `Agent` class delegates its `schedule()`/`scheduleEvery()`/
 * `getSchedule*()`/`listSchedules()`/`cancelSchedule()` methods, the
 * facet-scoped `_cf_*ForFacet` RPC entry points, and the
 * schedule-execution portion of `alarm()` here; the capability talks
 * to the agent only through the narrow internal AgentScheduler host slice.
 *
 * The physical Durable Object alarm stays owned by the agent —
 * `_scheduleNextAlarm` arbitrates the single alarm across schedules,
 * keepAlive heartbeats, fiber recovery, facet runs, and host timers.
 * This capability only reports candidate wake-up times
 * ({@link AgentScheduler.nextScheduleTimeMs} /
 * {@link AgentScheduler.nextHungIntervalRecheckMs}) and asks the agent
 * to re-arm via the `scheduleNextAlarm()` host closure.
 */

import { parseCronExpression } from "cron-schedule";
import { nanoid } from "nanoid";
import type {
  AgentLifecycle,
  AgentDestroyContext,
  AgentStartContext
} from "../agent/lifecycle";
import { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "../internal_context";
import {
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
  isPlatformTransientError,
  tryN,
  validateRetryOptions
} from "../retries";
import type { RetryOptions } from "../retries";
import type { Agent } from "../index";
import { getAgentSchedulerHost, type AgentSchedulerHost } from "./host";
import type {
  AgentPathStep,
  Schedule,
  ScheduleCriteria,
  ScheduleStorageRow
} from "./types";

function parseRetryOptions(
  row: Record<string, unknown>
): RetryOptions | undefined {
  return typeof row.retry_options === "string"
    ? (JSON.parse(row.retry_options) as RetryOptions)
    : undefined;
}

const SCHEDULE_SCHEMA_VERSION_KEY = "cf_agents:schedules_schema_version";
const CURRENT_SCHEDULE_SCHEMA_VERSION = 1;

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

function getNextCronTime(cron: string) {
  const interval = parseCronExpression(cron);
  return interval.getNextDate();
}

/**
 * Compute the storage key for a schedule owner path (`null` for rows
 * owned by the top-level agent itself).
 */
export function scheduleOwnerPathKey(
  path: ReadonlyArray<AgentPathStep> | null
): string | null {
  if (!path) return null;
  return path
    .map(
      (step) =>
        `${encodeURIComponent(step.className)}:${encodeURIComponent(step.name)}`
    )
    .join("/");
}

export class AgentScheduler implements AgentLifecycle {
  private readonly _host: AgentSchedulerHost;
  private _executingScheduleRowId?: string;

  constructor(owner: Agent) {
    const host = getAgentSchedulerHost(owner);
    if (!host) {
      throw new Error("AgentScheduler owner is not an Agent lifecycle host");
    }
    this._host = host;
  }

  async onStart(_context: AgentStartContext): Promise<void> {
    const version =
      (await this._host.storage.get<number>(SCHEDULE_SCHEMA_VERSION_KEY)) ?? 0;
    if (version >= CURRENT_SCHEDULE_SCHEMA_VERSION) return;

    this.ensureSchema();
    await this._host.storage.put(
      SCHEDULE_SCHEMA_VERSION_KEY,
      CURRENT_SCHEDULE_SCHEMA_VERSION
    );
  }

  /** @internal Re-run the idempotent schedule schema migration. */
  ensureSchema(): void {
    this._host.rawSql(`
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
        this._host.rawSql(statement);
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

    const rows = this._host
      .rawSql<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='cf_agents_schedules'"
      )
      .toArray();
    const ddl = rows[0]?.sql ?? "";
    if (ddl && !ddl.includes("'interval'")) {
      this._host.rawSql("DROP TABLE IF EXISTS cf_agents_schedules_new");
      this._host.rawSql(`
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
      this._host.rawSql(`
        INSERT INTO cf_agents_schedules_new
          (id, callback, payload, type, time, delayInSeconds, cron,
           intervalSeconds, running, created_at, execution_started_at,
           retry_options, owner_path, owner_path_key)
        SELECT id, callback, payload, type, time, delayInSeconds, cron,
               intervalSeconds, running, created_at, execution_started_at,
               retry_options, owner_path, owner_path_key
        FROM cf_agents_schedules
      `);
      this._host.rawSql("DROP TABLE cf_agents_schedules");
      this._host.rawSql(
        "ALTER TABLE cf_agents_schedules_new RENAME TO cf_agents_schedules"
      );
    }

    // keepAlive no longer uses schedule rows. Remove any orphaned heartbeat
    // schedules left by older Agents versions.
    this._host.rawSql(
      "DELETE FROM cf_agents_schedules WHERE callback = '_cf_keepAliveHeartbeat'"
    );
  }

  async onDestroy(_context: AgentDestroyContext): Promise<void> {
    this._host.rawSql("DROP TABLE IF EXISTS cf_agents_schedules");
  }

  /** @internal Consume the row ID retained when callback execution escaped. */
  takeExecutingScheduleRowId(): string | undefined {
    const id = this._executingScheduleRowId;
    this._executingScheduleRowId = undefined;
    return id;
  }

  /** @internal Remove the schedule rows selected by the alarm OOM breaker. */
  purgeMemoryLimitedRows(
    recoveryCallbacks: ReadonlyArray<string>,
    executingRowId?: string
  ): void {
    for (const callback of recoveryCallbacks) {
      try {
        this._host.sql`
          DELETE FROM cf_agents_schedules WHERE callback = ${callback}
        `;
      } catch {
        // best-effort at the post-OOM alarm boundary
      }
    }
    if (executingRowId) {
      try {
        this._host.sql`
          DELETE FROM cf_agents_schedules WHERE id = ${executingRowId}
        `;
      } catch {
        // best-effort at the post-OOM alarm boundary
      }
    }
  }

  /** @internal Back off the schedule rows selected by the alarm OOM breaker. */
  backoffMemoryLimitedRows(
    recoveryCallbacks: ReadonlyArray<string>,
    executingRowId: string | undefined,
    nextTime: number
  ): void {
    for (const callback of recoveryCallbacks) {
      try {
        this._host.sql`
          UPDATE cf_agents_schedules
          SET time = ${nextTime}
          WHERE callback = ${callback} AND time <= ${nextTime}
        `;
      } catch {
        // best-effort at the post-OOM alarm boundary
      }
    }
    if (executingRowId) {
      try {
        this._host.sql`
          UPDATE cf_agents_schedules
          SET time = ${nextTime}
          WHERE id = ${executingRowId} AND time <= ${nextTime}
        `;
      } catch {
        // best-effort at the post-OOM alarm boundary
      }
    }
  }

  /**
   * Schedule a task to be executed in the future (see
   * `Agent#schedule` for the public contract).
   */
  async schedule<T = string>(
    when: Date | string | number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<Schedule<T>> {
    this._host.validateScheduleCallback(when, callback, options);

    const result = this._host.isFacet()
      ? await (
          await this._host.rootAlarmOwner()
        )._cf_scheduleForFacet<T>(
          this._host.selfPath(),
          when,
          callback,
          payload,
          options
        )
      : await this.insertForOwner(null, when, callback, payload, options);

    if (result.created) {
      this._host.emit("schedule:create", {
        callback: result.schedule.callback,
        id: result.schedule.id
      });
    }
    return result.schedule;
  }

  /**
   * Schedule a task to run repeatedly at a fixed interval (see
   * `Agent#scheduleEvery` for the public contract).
   */
  async scheduleEvery<T = string>(
    intervalSeconds: number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; _idempotent?: boolean }
  ): Promise<Schedule<T>> {
    // DO alarms have a max schedule time of 30 days
    const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60; // 30 days in seconds

    if (typeof intervalSeconds !== "number" || intervalSeconds <= 0) {
      throw new Error("intervalSeconds must be a positive number");
    }

    if (intervalSeconds > MAX_INTERVAL_SECONDS) {
      throw new Error(
        `intervalSeconds cannot exceed ${MAX_INTERVAL_SECONDS} seconds (30 days)`
      );
    }

    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }

    if (
      typeof (this._host.agent as Record<string, unknown>)[callback] !==
      "function"
    ) {
      throw new Error(`this.${callback} is not a function`);
    }

    if (options?.retry) {
      validateRetryOptions(options.retry, this._host.retryDefaults());
    }

    const result = this._host.isFacet()
      ? await (
          await this._host.rootAlarmOwner()
        )._cf_scheduleEveryForFacet<T>(
          this._host.selfPath(),
          intervalSeconds,
          callback,
          payload,
          options
        )
      : await this.insertIntervalForOwner(
          null,
          intervalSeconds,
          callback,
          payload,
          options
        );

    if (result.created) {
      this._host.emit("schedule:create", {
        callback: result.schedule.callback,
        id: result.schedule.id
      });
    }
    return result.schedule;
  }

  /** Get a schedule by ID (synchronous; throws inside facets). */
  getSchedule<T = string>(id: string): Schedule<T> | undefined {
    if (this._host.isFacet()) {
      throw new Error(
        "getSchedule() is synchronous and cannot read parent-owned sub-agent schedules. " +
          "Use await this.getScheduleById(id) instead."
      );
    }
    return this.getForOwner(null, id);
  }

  /** Get a schedule by ID (facet-aware). */
  async getScheduleById(id: string): Promise<Schedule<unknown> | undefined> {
    if (this._host.isFacet()) {
      const root = await this._host.rootAlarmOwner();
      return root._cf_getScheduleForFacet(this._host.selfPath(), id);
    }
    return this.getForOwner(null, id);
  }

  /** List schedules matching criteria (synchronous; throws inside facets). */
  getSchedules<T = string>(criteria: ScheduleCriteria = {}): Schedule<T>[] {
    if (this._host.isFacet()) {
      throw new Error(
        "getSchedules() is synchronous and cannot read parent-owned sub-agent schedules. " +
          "Use await this.listSchedules(criteria) instead."
      );
    }

    return this.listForOwner(null, criteria);
  }

  /** List schedules matching criteria (facet-aware). */
  async listSchedules(
    criteria: ScheduleCriteria = {}
  ): Promise<Schedule<unknown>[]> {
    if (this._host.isFacet()) {
      const root = await this._host.rootAlarmOwner();
      return root._cf_listSchedulesForFacet(this._host.selfPath(), criteria);
    }
    return this.listForOwner(null, criteria);
  }

  /**
   * Cancel a schedule by ID, scoped to this agent's own rows. Emits
   * `schedule:cancel` on success.
   */
  async cancelSchedule(id: string): Promise<boolean> {
    if (this._host.isFacet()) {
      const root = await this._host.rootAlarmOwner();
      const result = await root._cf_cancelScheduleForFacet(
        this._host.selfPath(),
        id
      );
      if (result.ok && result.callback) {
        this._host.emit("schedule:cancel", { callback: result.callback, id });
      }
      return result.ok;
    }
    const schedule = this.getForOwner(null, id);
    if (!schedule) {
      return false;
    }

    this._host.emit("schedule:cancel", {
      callback: schedule.callback,
      id: schedule.id
    });

    this._host.sql`DELETE FROM cf_agents_schedules WHERE id = ${id}`;

    await this._host.scheduleNextAlarm();
    return true;
  }

  /**
   * Insert (or, for idempotent calls, return the existing row for) a
   * schedule owned by either the top-level agent (`ownerPath === null`)
   * or a descendant facet. Returns `{ schedule, created }` — `created`
   * is `false` when an idempotent insert deduplicates onto an existing
   * row, so callers can suppress the `schedule:create` event in that
   * case to match historic semantics.
   */
  async insertForOwner<T = string>(
    ownerPath: ReadonlyArray<AgentPathStep> | null,
    when: Date | string | number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    const ownerPathJson = ownerPath ? JSON.stringify(ownerPath) : null;
    const ownerPathKey = scheduleOwnerPathKey(ownerPath);
    const retryJson = options?.retry ? JSON.stringify(options.retry) : null;
    const payloadJson = JSON.stringify(payload);

    if (when instanceof Date) {
      const timestamp = Math.floor(when.getTime() / 1000);

      if (options?.idempotent) {
        const existing = this._host.sql<ScheduleStorageRow>`
          SELECT * FROM cf_agents_schedules
          WHERE type = 'scheduled'
            AND callback = ${callback}
            AND payload IS ${payloadJson}
            AND owner_path_key IS ${ownerPathKey}
          LIMIT 1
        `;

        if (existing.length > 0) {
          const row = existing[0];
          await this._host.scheduleNextAlarm();
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

      const id = nanoid(9);
      this._host.sql`
        INSERT OR REPLACE INTO cf_agents_schedules
          (id, callback, payload, type, time, retry_options, owner_path, owner_path_key)
        VALUES
          (${id}, ${callback}, ${payloadJson}, 'scheduled', ${timestamp}, ${retryJson}, ${ownerPathJson}, ${ownerPathKey})
      `;

      await this._host.scheduleNextAlarm();
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
      const timestamp = Math.floor((Date.now() + when * 1000) / 1000);

      if (options?.idempotent) {
        const existing = this._host.sql<ScheduleStorageRow>`
          SELECT * FROM cf_agents_schedules
          WHERE type = 'delayed'
            AND callback = ${callback}
            AND payload IS ${payloadJson}
            AND owner_path_key IS ${ownerPathKey}
          LIMIT 1
        `;

        if (existing.length > 0) {
          const row = existing[0];
          await this._host.scheduleNextAlarm();
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

      const id = nanoid(9);
      this._host.sql`
        INSERT OR REPLACE INTO cf_agents_schedules
          (id, callback, payload, type, delayInSeconds, time, retry_options, owner_path, owner_path_key)
        VALUES
          (${id}, ${callback}, ${payloadJson}, 'delayed', ${when}, ${timestamp}, ${retryJson}, ${ownerPathJson}, ${ownerPathKey})
      `;

      await this._host.scheduleNextAlarm();
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
      const timestamp = Math.floor(getNextCronTime(when).getTime() / 1000);
      const idempotent = options?.idempotent !== false;

      if (idempotent) {
        const existing = this._host.sql<ScheduleStorageRow>`
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
          await this._host.scheduleNextAlarm();
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

      const id = nanoid(9);
      this._host.sql`
        INSERT OR REPLACE INTO cf_agents_schedules
          (id, callback, payload, type, cron, time, retry_options, owner_path, owner_path_key)
        VALUES
          (${id}, ${callback}, ${payloadJson}, 'cron', ${when}, ${timestamp}, ${retryJson}, ${ownerPathJson}, ${ownerPathKey})
      `;

      await this._host.scheduleNextAlarm();
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
  async insertIntervalForOwner<T = string>(
    ownerPath: ReadonlyArray<AgentPathStep> | null,
    intervalSeconds: number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; _idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    const ownerPathJson = ownerPath ? JSON.stringify(ownerPath) : null;
    const ownerPathKey = scheduleOwnerPathKey(ownerPath);
    const idempotent = options?._idempotent !== false;
    const payloadJson = JSON.stringify(payload);

    if (idempotent) {
      const existing = this._host.sql<ScheduleStorageRow>`
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
        await this._host.scheduleNextAlarm();
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

    const id = nanoid(9);
    const timestamp = Math.floor((Date.now() + intervalSeconds * 1000) / 1000);
    const retryJson = options?.retry ? JSON.stringify(options.retry) : null;

    this._host.sql`
      INSERT OR REPLACE INTO cf_agents_schedules
        (id, callback, payload, type, intervalSeconds, time, running, retry_options, owner_path, owner_path_key)
      VALUES
        (${id}, ${callback}, ${payloadJson}, 'interval', ${intervalSeconds}, ${timestamp}, 0, ${retryJson}, ${ownerPathJson}, ${ownerPathKey})
    `;

    await this._host.scheduleNextAlarm();
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

  /**
   * Cancel a schedule row owned by a descendant facet, scoped by
   * `owner_path_key` so siblings can't reach each other's rows.
   * Returns the canceled row's callback name so the originating
   * facet can emit `schedule:cancel`. Does not emit observability
   * events itself.
   */
  async cancelForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>,
    id: string
  ): Promise<{ ok: boolean; callback?: string }> {
    const ownerPathKey = scheduleOwnerPathKey(ownerPath);
    const result = this._host.sql<ScheduleStorageRow>`
      SELECT * FROM cf_agents_schedules
      WHERE id = ${id} AND owner_path_key IS ${ownerPathKey}
    `;
    if (result.length === 0) return { ok: false };

    const callback = result[0].callback;
    this._host.sql`
      DELETE FROM cf_agents_schedules
      WHERE id = ${id} AND owner_path_key IS ${ownerPathKey}
    `;
    await this._host.scheduleNextAlarm();
    return { ok: true, callback };
  }

  /**
   * Bulk-cancel schedule rows whose `owner_path` starts with the given
   * prefix. Emits `schedule:cancel` on this agent (the alarm-owning
   * root) for each row removed — the facets being torn down may not be
   * alive to receive the events themselves. The caller re-arms the
   * alarm afterwards.
   */
  cancelOwnerPrefix(ownerPath: ReadonlyArray<AgentPathStep>): void {
    const rows = this._host.sql<ScheduleStorageRow>`
      SELECT * FROM cf_agents_schedules
      WHERE owner_path IS NOT NULL
    `;
    const rowsToDelete = rows.filter((row) => {
      if (!row.owner_path) return false;
      try {
        const rowOwnerPath = JSON.parse(row.owner_path) as AgentPathStep[];
        return this._host.isSameAgentPathPrefix(ownerPath, rowOwnerPath);
      } catch {
        return false;
      }
    });

    for (const row of rowsToDelete) {
      this._host.emit("schedule:cancel", {
        callback: row.callback,
        id: row.id
      });
      this._host.sql`DELETE FROM cf_agents_schedules WHERE id = ${row.id}`;
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
  getForOwner<T = string>(
    ownerPath: ReadonlyArray<AgentPathStep> | null,
    id: string
  ): Schedule<T> | undefined {
    const ownerPathKey = scheduleOwnerPathKey(ownerPath);
    const result = this._host.sql<ScheduleStorageRow>`
      SELECT * FROM cf_agents_schedules
      WHERE id = ${id} AND owner_path_key IS ${ownerPathKey}
    `;
    if (!result || result.length === 0) {
      return undefined;
    }
    return this.rowToSchedule<T>(result[0]);
  }

  /** List schedule rows for the given owner, filtered by criteria. */
  listForOwner<T = string>(
    ownerPath: ReadonlyArray<AgentPathStep> | null,
    criteria: ScheduleCriteria = {}
  ): Schedule<T>[] {
    const ownerPathKey = scheduleOwnerPathKey(ownerPath);
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

    return this._host
      .rawSql(query, ...params)
      .toArray()
      .map((row) =>
        this.rowToSchedule<T>(row as unknown as ScheduleStorageRow)
      );
  }

  /**
   * Execute a schedule row's callback on the agent inside the ALS
   * agent context, with retry handling. Used for rows owned by this
   * agent itself (facet-owned rows go through `dispatchFacetCallback`).
   */
  async executeCallback(row: ScheduleStorageRow): Promise<void> {
    const agent = this._host.agent as Record<string, unknown>;
    const callback = agent[row.callback];
    if (!callback) {
      console.error(`callback ${row.callback} not found`);
      return;
    }

    await agentContext.run(
      {
        agent: this._host.agent,
        connection: undefined,
        request: undefined,
        email: undefined
      },
      async () => {
        const retryOpts = parseRetryOptions(
          row as unknown as Record<string, unknown>
        );
        const { maxAttempts, baseDelayMs, maxDelayMs } = resolveRetryConfig(
          retryOpts,
          this._host.retryDefaults()
        );

        let parsedPayload: unknown;
        try {
          parsedPayload = JSON.parse(row.payload as string);
        } catch (e) {
          console.error(
            `Failed to parse payload for schedule "${row.id}" (callback "${row.callback}")`,
            e
          );
          this._host.emit("schedule:error", {
            callback: row.callback,
            id: row.id,
            error: e instanceof Error ? e.message : String(e),
            attempts: 0
          });
          return;
        }

        // A one-shot row is deleted by `alarm()` once this returns normally.
        // If it fails with a superseded-isolate error (a deploy / code update
        // replaced the isolate — "reset because its code was updated" or "this
        // script has been upgraded"), burning in-process retries is futile
        // (code never reloads mid-invocation) and swallowing the error would
        // let `alarm()` delete the row — permanently abandoning the work (e.g.
        // an interrupted chat-recovery continuation, or a queued submission's
        // drain alarm, leaving the submission orphaned with no driver). For
        // that transient we skip the doomed retries and re-throw so `alarm()`
        // rejects, the one-shot row survives, and the platform re-runs it on a
        // fresh isolate (= new code) under the at-least-once alarm guarantee.
        const isOneShotSchedule =
          row.type === "delayed" || row.type === "scheduled";
        const shouldDeferReset = (error: unknown): boolean =>
          isOneShotSchedule && isDurableObjectCodeUpdateReset(error);
        const shouldDeferOnExhaustion = (error: unknown): boolean =>
          isOneShotSchedule && isPlatformTransientError(error);
        const shouldDeferMemoryLimit = (error: unknown): boolean =>
          isOneShotSchedule && isDurableObjectMemoryLimitReset(error);

        try {
          this._host.emit("schedule:execute", {
            callback: row.callback,
            id: row.id
          });

          await tryN(
            maxAttempts,
            async (attempt) => {
              if (attempt > 1) {
                this._host.emit("schedule:retry", {
                  callback: row.callback,
                  id: row.id,
                  attempt,
                  maxAttempts
                });
              }
              await (
                callback as (
                  payload: unknown,
                  schedule: Schedule<unknown>
                ) => Promise<void>
              ).bind(this._host.agent)(
                parsedPayload,
                row as unknown as Schedule<unknown>
              );
            },
            {
              baseDelayMs,
              maxDelayMs,
              shouldRetry: (error) => !shouldDeferReset(error)
            }
          );
        } catch (e) {
          if (shouldDeferReset(e)) {
            console.warn(
              `Deferring scheduled callback "${row.callback}" to a fresh invocation after a Durable Object code-update reset; the one-shot row is preserved and the alarm will re-run on new code.`
            );
            throw e;
          }
          if (shouldDeferOnExhaustion(e)) {
            console.warn(
              `Deferring scheduled callback "${row.callback}" after exhausting in-process retries on a transient platform error; the one-shot row is preserved and the alarm will re-run once the platform recovers.`
            );
            throw e;
          }
          if (shouldDeferMemoryLimit(e)) {
            console.warn(
              `Deferring scheduled callback "${row.callback}" to the alarm memory-limit circuit breaker after a Durable Object memory-limit reset; the one-shot row is preserved so the breaker can bound the retry loop and seal it (#1825).`
            );
            throw e;
          }
          console.error(
            `error executing callback "${row.callback}" after ${maxAttempts} attempts`,
            e
          );
          this._host.emit("schedule:error", {
            callback: row.callback,
            id: row.id,
            error: e instanceof Error ? e.message : String(e),
            attempts: maxAttempts
          });
          try {
            await this._host.onError(e);
          } catch {
            // swallow onError errors
          }
        }
      }
    );
  }

  /**
   * Execute every due schedule row. Called from the agent's `alarm()`
   * after `super.alarm()` (so initialization has run) and before host
   * timers / housekeeping / alarm re-arming.
   */
  async fireDueSchedules(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // Get all schedules that should be executed now
    const result = this._host.sql<ScheduleStorageRow>`
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
            this._host.emit("schedule:duplicate_warning", {
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
          const hungTimeoutSeconds = this._host.hungScheduleTimeoutSeconds();
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
          this._host
            .sql`UPDATE cf_agents_schedules SET running = 1, execution_started_at = ${now} WHERE id = ${row.id}`;
        }

        if (row.owner_path) {
          try {
            const ownerPath = JSON.parse(row.owner_path) as AgentPathStep[];
            executed = await this._host.dispatchFacetCallback(ownerPath, row);
          } catch (e) {
            console.error(
              `error dispatching scheduled callback "${row.callback}"`,
              e
            );
            this._host.emit("schedule:error", {
              callback: row.callback,
              id: row.id,
              error: e instanceof Error ? e.message : String(e),
              attempts: 0
            });
            try {
              await this._host.onError(e);
            } catch {
              // swallow onError errors
            }
            // Reset the in-flight flag for interval rows so the row
            // doesn't stay stuck in `running=1` when dispatch fails
            // (e.g. the facet's registry entry is missing). The next
            // alarm cycle will retry.
            if (row.type === "interval") {
              this._host.sql`
                UPDATE cf_agents_schedules SET running = 0 WHERE id = ${row.id}
              `;
            }
            continue;
          }
        } else {
          // Retain the row ID when callback execution escapes so the Agent's
          // alarm-boundary memory-limit breaker can target the exact looping
          // row without owning schedule storage itself.
          this._executingScheduleRowId = row.id;
          await this.executeCallback(row);
          this._executingScheduleRowId = undefined;
          executed = true;
        }

        if (this._host.isDestroyed()) return;
        if (!executed) continue;

        if (row.type === "cron") {
          // Update next execution time for cron schedules
          const nextExecutionTime = getNextCronTime(row.cron ?? "");
          const nextTimestamp = Math.floor(nextExecutionTime.getTime() / 1000);

          this._host.sql`
            UPDATE cf_agents_schedules SET time = ${nextTimestamp} WHERE id = ${row.id}
          `;
        } else if (row.type === "interval") {
          // Reset running flag and schedule next interval execution
          const nextTimestamp =
            Math.floor(Date.now() / 1000) + (row.intervalSeconds ?? 0);

          this._host.sql`
            UPDATE cf_agents_schedules SET running = 0, time = ${nextTimestamp} WHERE id = ${row.id}
          `;
        } else {
          // Delete one-time schedules after execution
          this._host.sql`
            DELETE FROM cf_agents_schedules WHERE id = ${row.id}
          `;
        }
      }
    }
  }

  /**
   * Earliest wall-clock time (ms) a schedule row is ready to execute,
   * clamped to the future, or `null` when no row qualifies. One of the
   * candidate times arbitrated by the agent's `_scheduleNextAlarm`.
   */
  nextScheduleTimeMs(nowMs: number, hungCutoffSeconds: number): number | null {
    // Find the earliest schedule row that is safe to execute now, even if it
    // is already overdue. Overdue schedules can happen after a DO restart
    // because the SQLite row survives but the in-memory alarm does not.
    const readySchedules = this._host.sql<{
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
  nextHungIntervalRecheckMs(hungCutoffSeconds: number): number | null {
    // Running interval schedules that are not hung yet still need a future
    // alarm so the runtime can re-check them once they cross the hung timeout.
    const recoveringIntervals = this._host.sql<{
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
          this._host.hungScheduleTimeoutSeconds()) *
        1000
      );
    }
    return null;
  }
}
