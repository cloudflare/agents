import { DurableObject } from "cloudflare:workers";
import { parseCronExpression } from "cron-schedule";

// ── Retry utilities (inlined from agents/retries — not exported) ─────

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 3000
};

function jitterBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const upperBoundMs = Math.min(2 ** attempt * baseDelayMs, maxDelayMs);
  return Math.floor(Math.random() * upperBoundMs);
}

function validateRetryOptions(
  options: RetryOptions,
  defaults?: Required<RetryOptions>
): void {
  if (options.maxAttempts !== undefined) {
    if (!Number.isFinite(options.maxAttempts) || options.maxAttempts < 1) {
      throw new Error("retry.maxAttempts must be >= 1");
    }
    if (!Number.isInteger(options.maxAttempts)) {
      throw new Error("retry.maxAttempts must be an integer");
    }
  }
  if (options.baseDelayMs !== undefined) {
    if (!Number.isFinite(options.baseDelayMs) || options.baseDelayMs <= 0) {
      throw new Error("retry.baseDelayMs must be > 0");
    }
  }
  if (options.maxDelayMs !== undefined) {
    if (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs <= 0) {
      throw new Error("retry.maxDelayMs must be > 0");
    }
  }
  const resolvedBase = options.baseDelayMs ?? defaults?.baseDelayMs;
  const resolvedMax = options.maxDelayMs ?? defaults?.maxDelayMs;
  if (
    resolvedBase !== undefined &&
    resolvedMax !== undefined &&
    resolvedBase > resolvedMax
  ) {
    throw new Error("retry.baseDelayMs must be <= retry.maxDelayMs");
  }
}

async function tryN<T>(
  n: number,
  fn: (attempt: number) => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  if (!Number.isFinite(n) || n < 1) {
    throw new Error("retry.maxAttempts must be >= 1");
  }
  n = Math.floor(n);

  const baseDelayMs = Math.floor(options?.baseDelayMs ?? 100);
  const maxDelayMs = Math.floor(options?.maxDelayMs ?? 3000);

  let attempt = 1;
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt + 1 > n) throw err;
      const delay = jitterBackoff(attempt, baseDelayMs, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt++;
    }
  }
}

// ── Schedule types ───────────────────────────────────────────────────

export type Schedule<T = string> = {
  id: string;
  callback: string;
  payload: T;
  type: "scheduled" | "delayed" | "cron" | "interval";
  time: number;
  retry?: RetryOptions;
  cron?: string;
  delayInSeconds?: number;
  intervalSeconds?: number;
};

// ── SqlError ─────────────────────────────────────────────────────────

export class SqlError extends Error {
  readonly query: string;
  constructor(query: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`SQL query failed: ${message}`, { cause });
    this.name = "SqlError";
    this.query = query;
  }
}

// ── Options ──────────────────────────────────────────────────────────

export interface AgentFacetOptions {
  hungScheduleTimeoutSeconds?: number;
  retry?: RetryOptions;
}

const DEFAULT_OPTIONS = {
  hungScheduleTimeoutSeconds: 30,
  retry: DEFAULT_RETRY
};

// ── nanoid (tiny inline — avoids dependency for IDs) ─────────────────

function nanoid(size = 9): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let id = "";
  for (const b of bytes) id += chars[b & 63];
  return id;
}

// ── AgentFacet ───────────────────────────────────────────────────────

/**
 * Base class for facets — child DurableObjects with isolated SQLite,
 * created by a parent Agent via ctx.facets.
 *
 * Provides the same developer ergonomics as Agent for the things
 * facets need, without WebSocket/connection/state-sync machinery.
 *
 * - this.sql tagged template
 * - Full scheduling API (delayed, Date, cron, interval with overlap detection)
 * - Abort controller lifecycle
 * - this.retry() with jittered backoff
 * - onError() hook
 * - onStart() lifecycle hook (async init on first call)
 * - _destroyed flag for graceful shutdown
 */
export class AgentFacet<
  Env extends Cloudflare.Env = Cloudflare.Env
> extends DurableObject<Env> {
  private _abortControllers = new Map<string, AbortController>();
  private _destroyed = false;
  private _started = false;

  /** Override to configure retry defaults and hung schedule timeout. */
  static options: AgentFacetOptions = {};

  private get _resolvedOptions() {
    const ctor = this.constructor as typeof AgentFacet;
    const userRetry = ctor.options?.retry;
    return {
      hungScheduleTimeoutSeconds:
        ctor.options?.hungScheduleTimeoutSeconds ??
        DEFAULT_OPTIONS.hungScheduleTimeoutSeconds,
      retry: {
        maxAttempts:
          userRetry?.maxAttempts ?? DEFAULT_OPTIONS.retry.maxAttempts,
        baseDelayMs:
          userRetry?.baseDelayMs ?? DEFAULT_OPTIONS.retry.baseDelayMs,
        maxDelayMs: userRetry?.maxDelayMs ?? DEFAULT_OPTIONS.retry.maxDelayMs
      }
    };
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_facet_schedules (
        id TEXT PRIMARY KEY NOT NULL,
        callback TEXT NOT NULL,
        payload TEXT,
        type TEXT NOT NULL CHECK(type IN ('scheduled','delayed','cron','interval')),
        cron TEXT,
        delayInSeconds INTEGER,
        intervalSeconds INTEGER,
        time INTEGER NOT NULL,
        running INTEGER DEFAULT 0,
        execution_started_at INTEGER,
        retry_options TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Override for async initialization. Runs once before the first
   * RPC method call. Constructor can't be async — use this instead.
   */
  async onStart(): Promise<void> {}

  /** Ensure onStart has run. Call at the top of public methods. */
  protected async _ensureStarted(): Promise<void> {
    if (this._started) return;
    this._started = true;
    await this.onStart();
  }

  /**
   * Override to customize error handling. Called by this.sql on
   * query failures and by the alarm handler on callback errors.
   * Default: re-throws the error.
   */
  onError(error: unknown): unknown {
    throw error;
  }

  async destroy(): Promise<void> {
    this._destroyed = true;
    for (const controller of this._abortControllers.values()) {
      controller.abort();
    }
    this._abortControllers.clear();
  }

  // ── SQL tagged template ────────────────────────────────────────────

  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    let query = "";
    try {
      query = strings.reduce(
        (acc, str, i) => acc + str + (i < values.length ? "?" : ""),
        ""
      );
      return [...this.ctx.storage.sql.exec(query, ...values)] as T[];
    } catch (e) {
      throw this.onError(new SqlError(query, e));
    }
  }

  // ── Retry ──────────────────────────────────────────────────────────

  async retry<T>(
    fn: (attempt: number) => Promise<T>,
    options?: RetryOptions
  ): Promise<T> {
    const defaults = this._resolvedOptions.retry;
    return tryN(options?.maxAttempts ?? defaults.maxAttempts, fn, {
      baseDelayMs: options?.baseDelayMs ?? defaults.baseDelayMs,
      maxDelayMs: options?.maxDelayMs ?? defaults.maxDelayMs
    });
  }

  // ── Abort / Cancel ─────────────────────────────────────────────────

  getAbortSignal(requestId: string): AbortSignal {
    if (!this._abortControllers.has(requestId)) {
      this._abortControllers.set(requestId, new AbortController());
    }
    return this._abortControllers.get(requestId)!.signal;
  }

  cancelRequest(requestId: string): void {
    this._abortControllers.get(requestId)?.abort();
    this._abortControllers.delete(requestId);
  }

  removeAbortController(requestId: string): void {
    this._abortControllers.delete(requestId);
  }

  // ── Scheduling ─────────────────────────────────────────────────────

  async schedule<T = string>(
    when: Date | string | number,
    callback: keyof this & string,
    payload?: T,
    options?: { retry?: RetryOptions }
  ): Promise<Schedule<T>> {
    const id = nanoid();

    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }
    if (typeof (this as Record<string, unknown>)[callback] !== "function") {
      throw new Error(`this.${callback} is not a function`);
    }

    if (options?.retry) {
      validateRetryOptions(options.retry, this._resolvedOptions.retry);
    }

    const retryJson = options?.retry ? JSON.stringify(options.retry) : null;
    const payloadJson = JSON.stringify(payload ?? null);

    if (when instanceof Date) {
      const timestamp = Math.floor(when.getTime() / 1000);
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO cf_facet_schedules (id, callback, payload, type, time, retry_options)
         VALUES (?, ?, ?, 'scheduled', ?, ?)`,
        id,
        callback,
        payloadJson,
        timestamp,
        retryJson
      );
      await this._scheduleNextAlarm();
      return {
        id,
        callback,
        payload: payload as T,
        type: "scheduled",
        time: timestamp,
        retry: options?.retry
      };
    }

    if (typeof when === "number") {
      const timestamp = Math.floor((Date.now() + when * 1000) / 1000);
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO cf_facet_schedules (id, callback, payload, type, delayInSeconds, time, retry_options)
         VALUES (?, ?, ?, 'delayed', ?, ?, ?)`,
        id,
        callback,
        payloadJson,
        when,
        timestamp,
        retryJson
      );
      await this._scheduleNextAlarm();
      return {
        id,
        callback,
        payload: payload as T,
        type: "delayed",
        time: timestamp,
        delayInSeconds: when,
        retry: options?.retry
      };
    }

    if (typeof when === "string") {
      const nextTime = parseCronExpression(when).getNextDate();
      const timestamp = Math.floor(nextTime.getTime() / 1000);
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO cf_facet_schedules (id, callback, payload, type, cron, time, retry_options)
         VALUES (?, ?, ?, 'cron', ?, ?, ?)`,
        id,
        callback,
        payloadJson,
        when,
        timestamp,
        retryJson
      );
      await this._scheduleNextAlarm();
      return {
        id,
        callback,
        payload: payload as T,
        type: "cron",
        time: timestamp,
        cron: when,
        retry: options?.retry
      };
    }

    throw new Error(`Invalid schedule type: ${JSON.stringify(when)}`);
  }

  async scheduleEvery<T = string>(
    intervalSeconds: number,
    callback: keyof this & string,
    payload?: T,
    options?: { retry?: RetryOptions }
  ): Promise<Schedule<T>> {
    const MAX_INTERVAL = 30 * 24 * 60 * 60;
    if (typeof intervalSeconds !== "number" || intervalSeconds <= 0) {
      throw new Error("intervalSeconds must be a positive number");
    }
    if (intervalSeconds > MAX_INTERVAL) {
      throw new Error(`intervalSeconds cannot exceed ${MAX_INTERVAL} seconds`);
    }
    if (typeof (this as Record<string, unknown>)[callback] !== "function") {
      throw new Error(`this.${callback} is not a function`);
    }
    if (options?.retry) {
      validateRetryOptions(options.retry, this._resolvedOptions.retry);
    }

    const id = nanoid();
    const timestamp = Math.floor((Date.now() + intervalSeconds * 1000) / 1000);
    const retryJson = options?.retry ? JSON.stringify(options.retry) : null;
    const payloadJson = JSON.stringify(payload ?? null);

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_facet_schedules (id, callback, payload, type, intervalSeconds, time, running, retry_options)
       VALUES (?, ?, ?, 'interval', ?, ?, 0, ?)`,
      id,
      callback,
      payloadJson,
      intervalSeconds,
      timestamp,
      retryJson
    );
    await this._scheduleNextAlarm();
    return {
      id,
      callback,
      payload: payload as T,
      type: "interval",
      time: timestamp,
      intervalSeconds,
      retry: options?.retry
    };
  }

  getSchedule<T = string>(id: string): Schedule<T> | undefined {
    const rows = [
      ...this.ctx.storage.sql.exec(
        "SELECT * FROM cf_facet_schedules WHERE id = ?",
        id
      )
    ] as Array<Record<string, unknown>>;
    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      ...row,
      payload: JSON.parse(row.payload as string) as T,
      retry: row.retry_options
        ? (JSON.parse(row.retry_options as string) as RetryOptions)
        : undefined
    } as Schedule<T>;
  }

  getSchedules<T = string>(
    criteria: {
      id?: string;
      type?: "scheduled" | "delayed" | "cron" | "interval";
    } = {}
  ): Schedule<T>[] {
    let query = "SELECT * FROM cf_facet_schedules WHERE 1=1";
    const params: (string | number)[] = [];
    if (criteria.id) {
      query += " AND id = ?";
      params.push(criteria.id);
    }
    if (criteria.type) {
      query += " AND type = ?";
      params.push(criteria.type);
    }
    return [...this.ctx.storage.sql.exec(query, ...params)].map((row) => {
      const r = row as Record<string, unknown>;
      return {
        ...r,
        payload: JSON.parse(r.payload as string) as T,
        retry: r.retry_options
          ? (JSON.parse(r.retry_options as string) as RetryOptions)
          : undefined
      } as Schedule<T>;
    });
  }

  async cancelSchedule(id: string): Promise<boolean> {
    const schedule = this.getSchedule(id);
    if (!schedule) return false;
    this.ctx.storage.sql.exec(
      "DELETE FROM cf_facet_schedules WHERE id = ?",
      id
    );
    await this._scheduleNextAlarm();
    return true;
  }

  private async _scheduleNextAlarm() {
    const now = Math.floor(Date.now() / 1000);
    const rows = [
      ...this.ctx.storage.sql.exec(
        "SELECT time FROM cf_facet_schedules WHERE time >= ? ORDER BY time ASC LIMIT 1",
        now
      )
    ] as Array<{ time: number }>;
    if (rows.length > 0) {
      await this.ctx.storage.setAlarm(rows[0].time * 1000);
    }
  }

  // ── Alarm handler ──────────────────────────────────────────────────

  public readonly alarm = async () => {
    const now = Math.floor(Date.now() / 1000);
    const rows = [
      ...this.ctx.storage.sql.exec(
        "SELECT * FROM cf_facet_schedules WHERE time <= ?",
        now
      )
    ] as Array<Record<string, unknown>>;

    for (const row of rows) {
      if (this._destroyed) return;

      const callbackName = row.callback as string;
      const callback = (this as Record<string, unknown>)[callbackName];
      if (typeof callback !== "function") {
        console.error(`[AgentFacet] callback ${callbackName} not found`);
        continue;
      }

      if (row.type === "interval" && row.running === 1) {
        const startedAt = (row.execution_started_at as number) ?? 0;
        const elapsed = now - startedAt;
        if (elapsed < this._resolvedOptions.hungScheduleTimeoutSeconds) {
          console.warn(
            `[AgentFacet] Skipping interval ${row.id}: previous execution still running`
          );
          continue;
        }
        console.warn(
          `[AgentFacet] Forcing reset of hung interval ${row.id} (started ${elapsed}s ago)`
        );
      }

      if (row.type === "interval") {
        this.ctx.storage.sql.exec(
          "UPDATE cf_facet_schedules SET running = 1, execution_started_at = ? WHERE id = ?",
          now,
          row.id as string
        );
      }

      const retryOpts: RetryOptions | undefined = row.retry_options
        ? (JSON.parse(row.retry_options as string) as RetryOptions)
        : undefined;
      const defaults = this._resolvedOptions.retry;
      const maxAttempts = retryOpts?.maxAttempts ?? defaults.maxAttempts;
      const baseDelayMs = retryOpts?.baseDelayMs ?? defaults.baseDelayMs;
      const maxDelayMs = retryOpts?.maxDelayMs ?? defaults.maxDelayMs;
      const parsedPayload = JSON.parse((row.payload as string) ?? "null");

      try {
        await tryN(
          maxAttempts,
          async () => {
            await (callback as Function).call(this, parsedPayload);
          },
          { baseDelayMs, maxDelayMs }
        );
      } catch (e) {
        try {
          this.onError(e);
        } catch {
          // swallow onError errors in alarm handler
        }
      }

      if (this._destroyed) return;

      if (row.type === "cron") {
        const nextTime = parseCronExpression(row.cron as string).getNextDate();
        const nextTimestamp = Math.floor(nextTime.getTime() / 1000);
        this.ctx.storage.sql.exec(
          "UPDATE cf_facet_schedules SET time = ? WHERE id = ?",
          nextTimestamp,
          row.id as string
        );
      } else if (row.type === "interval") {
        const nextTimestamp =
          Math.floor(Date.now() / 1000) +
          ((row.intervalSeconds as number) ?? 0);
        this.ctx.storage.sql.exec(
          "UPDATE cf_facet_schedules SET time = ?, running = 0 WHERE id = ?",
          nextTimestamp,
          row.id as string
        );
      } else {
        this.ctx.storage.sql.exec(
          "DELETE FROM cf_facet_schedules WHERE id = ?",
          row.id as string
        );
      }
    }

    await this._scheduleNextAlarm();
  };
}
