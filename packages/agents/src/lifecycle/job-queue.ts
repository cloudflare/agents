/**
 * Durable job queue owned by Lifecycle.
 *
 * One timestamp-ordered table holds every pending job for the Durable
 * Object. A job is a serialisable callback address — owning capability plus
 * function name — with a due time and a payload. Capabilities and the host
 * push jobs through their scoped `LifecycleJobs` surface; Lifecycle's alarm
 * event loop drives due jobs and derives the physical alarm from queue
 * state. Payloads are opaque to the queue.
 */

import { nanoid } from "nanoid";
import type { RetryOptions } from "../retries";
import { SqlError } from "../sql-error";

/** Capability id under which host-owned jobs are stored. */
export const HOST_JOB_CAPABILITY = "host";

/** Seconds before an in-flight single-flight job is treated as hung. */
const DEFAULT_HUNG_TIMEOUT_SECONDS = 30;

/** One durable job in the Lifecycle queue. */
export type LifecycleJob = {
  /** Unique job id. Stable across reschedules. */
  readonly id: string;
  /** Owning capability id, or `"host"`. */
  readonly capability: string;
  /** Serialisable function name the owner dispatches on. */
  readonly fn: string;
  /** Due time in epoch milliseconds. */
  readonly time: number;
  /** Owner-defined payload, JSON round-tripped. */
  readonly payload: unknown;
  /** Retry policy for dispatch, when the pusher supplied one. */
  readonly retry: RetryOptions | undefined;
  /** Whether the job is skipped while a previous run is in flight. */
  readonly singleflight: boolean;
  /** Whether the job suppresses ordinary alarm candidates while pending. */
  readonly exclusive: boolean;
  /** Whether the alarm memory-limit breaker governs this pending job (#1825). */
  readonly recoveryLoop: boolean;
  /** Creation time in epoch seconds. */
  readonly createdAt: number;
};

/** Options accepted when pushing one job. */
export type LifecycleJobPushOptions = {
  /** Serialisable function name the owner dispatches on. */
  readonly fn: string;
  /** Due time in epoch milliseconds. */
  readonly time: number;
  /** Owner-defined payload. Must be JSON-serializable. */
  readonly payload?: unknown;
  /**
   * Stable job id. A push with an existing id replaces that job.
   * Omitted ids are generated.
   */
  readonly id?: string;
  /** Retry policy for dispatch, overriding the queue default. */
  readonly retry?: RetryOptions;
  /** Skip this job while a previous run of it is still in flight. */
  readonly singleflight?: boolean;
  /**
   * Seconds before an in-flight single-flight run is treated as hung, and
   * before any long dispatch triggers the slow-dispatch warning. Default: 30.
   */
  readonly hungTimeoutSeconds?: number;
  /** Suppress ordinary alarm candidates while this job is pending. */
  readonly exclusive?: boolean;
  /**
   * Mark this job as part of a recovery loop that can deterministically
   * exhaust memory. On an alarm memory-limit strike the circuit breaker
   * (#1825) backs off every pending flagged job to the strike's backoff
   * time, and purges them all when it seals at the strike budget — so a
   * doomed loop cannot re-trigger through a sibling row while unrelated
   * jobs stay untouched.
   */
  readonly recoveryLoop?: boolean;
};

/**
 * What the owner tells Lifecycle after one job ran — the drive result.
 *
 * `undefined` (or no return) completes the job and deletes it.
 * `{ rescheduleAt }` suspends the job until a future time.
 * `"yield"` leaves the job due, waking again immediately.
 *
 * A same-id `push()` or `reschedule()` made while the job is dispatching
 * supersedes the drive result: the newer durable intent wins, and the
 * result is quietly discarded. Owners that both push and return outcomes
 * for the same job should derive both from the same durable state so the
 * two always agree.
 */
export type LifecycleJobOutcome =
  | undefined
  | { readonly rescheduleAt: number }
  | "yield";

/** Context supplied when a job is dispatched to its owner. */
export type LifecycleJobContext = {
  /** The due job being executed. */
  readonly job: LifecycleJob;
  /** 1-indexed dispatch attempt within the current alarm invocation. */
  readonly attempt: number;
};

/** Job-queue access scoped to one owning capability. */
export type LifecycleJobs = {
  /**
   * Push one job. A push with an existing id replaces that job — ids are
   * scoped to their owner, so replacing (or colliding with) another
   * owner's job is impossible; a cross-owner id collision throws instead.
   */
  readonly push: (options: LifecycleJobPushOptions) => Promise<LifecycleJob>;
  /** Cancel one owned job. Returns false when no job matched. */
  readonly cancel: (id: string) => Promise<boolean>;
  /** Re-time one owned job. Returns false when no job matched. */
  readonly reschedule: (id: string, time: number) => Promise<boolean>;
  /** Read one owned job. */
  readonly get: (id: string) => LifecycleJob | undefined;
  /** List every owned job, ordered by due time. */
  readonly list: () => LifecycleJob[];
  /**
   * Recompute the physical alarm from queue state without mutating it.
   * Mutations re-arm automatically; use this only to recover a lost alarm
   * for existing jobs (e.g. an idempotent push that deduplicated).
   */
  readonly rearm: () => Promise<void>;
};

/** @internal Raw `cf_agents_jobs` SQLite row. */
export type JobStorageRow = {
  id: string;
  capability: string;
  fn: string;
  time: number;
  payload: string | null;
  retry_options: string | null;
  singleflight: number;
  hung_timeout_seconds: number | null;
  exclusive: number;
  recovery_loop: number;
  running: number;
  execution_started_at: number | null;
  created_at: number;
};

/** @internal Convert one raw queue row into its public job shape. */
export function jobFromRow(row: JobStorageRow): LifecycleJob {
  return {
    id: row.id,
    capability: row.capability,
    fn: row.fn,
    time: row.time,
    payload:
      typeof row.payload === "string" ? JSON.parse(row.payload) : undefined,
    retry:
      typeof row.retry_options === "string"
        ? (JSON.parse(row.retry_options) as RetryOptions)
        : undefined,
    singleflight: row.singleflight === 1,
    exclusive: row.exclusive === 1,
    recoveryLoop: row.recovery_loop === 1,
    createdAt: row.created_at
  };
}

/** @internal One row's hung/slow-dispatch threshold in milliseconds. */
export function hungTimeoutMs(row: JobStorageRow): number {
  return (row.hung_timeout_seconds ?? DEFAULT_HUNG_TIMEOUT_SECONDS) * 1000;
}

/** Whether an in-flight single-flight job has crossed its hung timeout. */
export function isHungRow(row: JobStorageRow, nowMs: number): boolean {
  return nowMs - (row.execution_started_at ?? 0) >= hungTimeoutMs(row);
}

type RevisionEntry = { revision: number; dispatches: number };

/** @internal One dispatch's claim on a job (see {@link JobQueue.claim}). */
export type JobClaim = {
  readonly id: string;
  readonly entry: RevisionEntry;
  readonly revision: number;
};

/**
 * @internal SQL-backed job queue. Lifecycle owns the single instance; the
 * scoped `LifecycleJobs` surfaces delegate here with a fixed capability id.
 */
export class JobQueue {
  readonly #storage: DurableObjectStorage;
  #tableEnsured = false;
  /**
   * The revision of each job a dispatch is driving, bumped by every change
   * of durable intent (push, reschedule, cancel, the breaker's retimes and
   * deletes) and by a hung takeover. A dispatch acts on its job only while
   * the revision it claimed is unchanged. An entry lives while dispatches
   * of that id are in flight, so the map stays as small as the dispatches;
   * a dispatch never outlives its isolate, so nothing needs persisting.
   */
  readonly #inFlight = new Map<string, RevisionEntry>();

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  #sql<T = JobStorageRow>(
    query: string,
    ...params: (string | number | null)[]
  ): T[] {
    this.#ensureTable();
    try {
      return [...this.#storage.sql.exec(query, ...params)] as T[];
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  #ensureTable(): void {
    if (this.#tableEnsured) return;
    this.#storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        capability TEXT NOT NULL,
        fn TEXT NOT NULL,
        time INTEGER NOT NULL,
        payload TEXT,
        retry_options TEXT,
        singleflight INTEGER NOT NULL DEFAULT 0,
        hung_timeout_seconds INTEGER,
        exclusive INTEGER NOT NULL DEFAULT 0,
        recovery_loop INTEGER NOT NULL DEFAULT 0,
        running INTEGER NOT NULL DEFAULT 0,
        execution_started_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      ) WITHOUT ROWID`);
    this.#tableEnsured = true;
  }

  #revise(id: string): void {
    const entry = this.#inFlight.get(id);
    if (entry) entry.revision += 1;
  }

  /**
   * Claim a due job for one dispatch: mark it running and record its
   * revision. A takeover of a hung job first invalidates the dispatches
   * still holding it. Release the claim when the dispatch ends.
   */
  claim(id: string, nowMs: number, takeover = false): JobClaim {
    let entry = this.#inFlight.get(id);
    if (!entry) {
      entry = { revision: 0, dispatches: 0 };
      this.#inFlight.set(id, entry);
    } else if (takeover) {
      entry.revision += 1;
    }
    entry.dispatches += 1;
    this.markRunning(id, nowMs);
    return { id, entry, revision: entry.revision };
  }

  /** End one dispatch's claim. */
  release(claim: JobClaim): void {
    claim.entry.dispatches -= 1;
    if (
      claim.entry.dispatches === 0 &&
      this.#inFlight.get(claim.id) === claim.entry
    ) {
      this.#inFlight.delete(claim.id);
    }
  }

  /**
   * Whether the job still exists as the dispatch claimed it: no cancel,
   * push, reschedule, breaker retime or hung takeover touched it since.
   */
  isCurrent(claim: JobClaim): boolean {
    return (
      this.#inFlight.get(claim.id) === claim.entry &&
      claim.entry.revision === claim.revision &&
      this.#sql("SELECT id FROM cf_agents_jobs WHERE id = ?", claim.id).length >
        0
    );
  }

  push(capability: string, options: LifecycleJobPushOptions): LifecycleJob {
    if (!Number.isFinite(options.time) || options.time < 0) {
      throw new Error(`Invalid job time: ${String(options.time)}`);
    }
    if (typeof options.fn !== "string" || options.fn.trim() === "") {
      throw new Error("Jobs require a non-empty fn");
    }
    const id = options.id ?? nanoid(9);
    // Job ids are scoped to their owner, like every other queue verb: a
    // same-id push replaces only the pusher's own job (the conflict update
    // is a no-op against another owner's row, surfaced as the ownership
    // error below), and it bumps the job's revision so this newer durable
    // intent wins over a concurrently returned drive result.
    this.#sql(
      `INSERT INTO cf_agents_jobs
        (id, capability, fn, time, payload, retry_options, singleflight,
         hung_timeout_seconds, exclusive, recovery_loop, running,
         execution_started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
       ON CONFLICT(id) DO UPDATE SET
         fn = excluded.fn,
         time = excluded.time,
         payload = excluded.payload,
         retry_options = excluded.retry_options,
         singleflight = excluded.singleflight,
         hung_timeout_seconds = excluded.hung_timeout_seconds,
         exclusive = excluded.exclusive,
         recovery_loop = excluded.recovery_loop,
         running = 0,
         execution_started_at = NULL
       WHERE cf_agents_jobs.capability = excluded.capability`,
      id,
      capability,
      options.fn,
      Math.floor(options.time),
      options.payload === undefined ? null : JSON.stringify(options.payload),
      options.retry ? JSON.stringify(options.retry) : null,
      options.singleflight ? 1 : 0,
      options.hungTimeoutSeconds ?? null,
      options.exclusive ? 1 : 0,
      options.recoveryLoop ? 1 : 0
    );
    const job = this.get(capability, id);
    if (job) this.#revise(id);
    if (!job) {
      const owner = this.#sql<{ capability: string }>(
        "SELECT capability FROM cf_agents_jobs WHERE id = ?",
        id
      )[0]?.capability;
      throw new Error(
        owner !== undefined
          ? `Job id ${JSON.stringify(id)} already belongs to ` +
              `${JSON.stringify(owner)}; job ids are scoped to their owner`
          : `Failed to persist job ${id}`
      );
    }
    return job;
  }

  cancel(capability: string, id: string): boolean {
    const existing = this.#sql(
      "SELECT id FROM cf_agents_jobs WHERE id = ? AND capability = ?",
      id,
      capability
    );
    if (existing.length === 0) return false;
    this.#revise(id);
    this.#sql(
      "DELETE FROM cf_agents_jobs WHERE id = ? AND capability = ?",
      id,
      capability
    );
    return true;
  }

  reschedule(capability: string, id: string, time: number): boolean {
    if (!Number.isFinite(time) || time < 0) {
      throw new Error(`Invalid job time: ${String(time)}`);
    }
    const existing = this.#sql(
      "SELECT id FROM cf_agents_jobs WHERE id = ? AND capability = ?",
      id,
      capability
    );
    if (existing.length === 0) return false;
    this.#revise(id);
    this.#sql(
      `UPDATE cf_agents_jobs
       SET time = ?, running = 0, execution_started_at = NULL
       WHERE id = ? AND capability = ?`,
      Math.floor(time),
      id,
      capability
    );
    return true;
  }

  get(capability: string, id: string): LifecycleJob | undefined {
    const rows = this.#sql(
      "SELECT * FROM cf_agents_jobs WHERE id = ? AND capability = ?",
      id,
      capability
    );
    return rows[0] ? jobFromRow(rows[0]) : undefined;
  }

  list(capability: string): LifecycleJob[] {
    return this.#sql(
      "SELECT * FROM cf_agents_jobs WHERE capability = ? ORDER BY time ASC",
      capability
    ).map(jobFromRow);
  }

  /** Raw due rows at `nowMs`, ordered by due time. */
  due(nowMs: number): JobStorageRow[] {
    return this.#sql(
      "SELECT * FROM cf_agents_jobs WHERE time <= ? ORDER BY time ASC",
      Math.floor(nowMs)
    );
  }

  /** One job's current row when it still exists and is still due. */
  dueRow(id: string, nowMs: number): JobStorageRow | undefined {
    return this.#sql(
      "SELECT * FROM cf_agents_jobs WHERE id = ? AND time <= ?",
      id,
      Math.floor(nowMs)
    )[0];
  }

  markRunning(id: string, nowMs: number): void {
    this.#sql(
      `UPDATE cf_agents_jobs
       SET running = 1, execution_started_at = ?
       WHERE id = ?`,
      Math.floor(nowMs),
      id
    );
  }

  clearRunning(id: string): void {
    this.#sql(
      `UPDATE cf_agents_jobs
       SET running = 0, execution_started_at = NULL
       WHERE id = ?`,
      id
    );
  }

  delete(id: string): void {
    this.#revise(id);
    this.#sql("DELETE FROM cf_agents_jobs WHERE id = ?", id);
  }

  /**
   * Unguarded retime for the alarm memory-limit breaker's backoff, which
   * must land regardless of any dispatch: it is protecting the object. It
   * bumps the revision, so no dispatch's drive result overrides it.
   */
  retime(id: string, time: number): void {
    this.#revise(id);
    this.#sql(
      `UPDATE cf_agents_jobs
       SET time = ?, running = 0, execution_started_at = NULL
       WHERE id = ?`,
      Math.floor(time),
      id
    );
  }

  /**
   * Back off every pending recovery-loop job that would fire before the
   * breaker's backoff time (#1825), so a doomed loop's sibling rows cannot
   * re-trigger it on the next wake. Unguarded like {@link retime}: the
   * breaker's backoff must land regardless of any dispatch.
   */
  delayRecoveryLoopJobs(time: number): void {
    for (const { id } of this.#sql<{ id: string }>(
      "SELECT id FROM cf_agents_jobs WHERE recovery_loop = 1 AND time <= ?",
      Math.floor(time)
    )) {
      this.#revise(id);
    }
    this.#sql(
      `UPDATE cf_agents_jobs
       SET time = ?, running = 0, execution_started_at = NULL
       WHERE recovery_loop = 1 AND time <= ?`,
      Math.floor(time),
      Math.floor(time)
    );
  }

  /**
   * Read every recovery-loop job before breaker sealing. The memory-limit
   * policy phase uses this snapshot after the rows are purged so routed owners
   * can terminalize their own durable recovery state.
   */
  recoveryLoopJobs(): LifecycleJob[] {
    return this.#sql(
      "SELECT * FROM cf_agents_jobs WHERE recovery_loop = 1 ORDER BY time ASC"
    ).map(jobFromRow);
  }

  /**
   * Purge every recovery-loop job when the breaker seals at its strike
   * budget (#1825). Unrelated jobs are untouched.
   */
  purgeRecoveryLoopJobs(): void {
    for (const { id } of this.#sql<{ id: string }>(
      "SELECT id FROM cf_agents_jobs WHERE recovery_loop = 1"
    )) {
      this.#revise(id);
    }
    this.#sql("DELETE FROM cf_agents_jobs WHERE recovery_loop = 1");
  }

  /**
   * Apply one drive result, guarded on the revision the dispatch claimed
   * the job at. A cancel, same-id push or reschedule made meanwhile bumped
   * it: newer durable intent exists, so the outcome quietly defers to it
   * instead of deleting or retiming the fresher job. Another dispatch of
   * the same unchanged job (overlapping alarms) does not bump it, so either
   * dispatch's result applies.
   */
  applyOutcome(claim: JobClaim, outcome: LifecycleJobOutcome): void {
    if (!this.isCurrent(claim)) return;
    const { id } = claim;
    if (outcome === undefined) {
      this.#sql("DELETE FROM cf_agents_jobs WHERE id = ?", id);
      return;
    }
    if (outcome === "yield") {
      this.clearRunning(id);
      return;
    }
    if (
      typeof outcome === "object" &&
      Number.isFinite(outcome.rescheduleAt) &&
      outcome.rescheduleAt >= 0
    ) {
      this.#sql(
        `UPDATE cf_agents_jobs
         SET time = ?, running = 0, execution_started_at = NULL
         WHERE id = ?`,
        Math.floor(outcome.rescheduleAt),
        id
      );
      return;
    }
    throw new Error(`Invalid job outcome for ${id}`);
  }

  /**
   * The next physical alarm time derived from queue state, or `null` when
   * the queue holds nothing to wake for.
   *
   * Exclusive jobs suppress ordinary candidates. An ordinary candidate is
   * the earliest ready job clamped to the future (overdue rows survive
   * restarts and must re-fire immediately), merged with the earliest
   * hung-timeout recheck for in-flight single-flight jobs.
   */
  nextAlarmTime(nowMs: number): number | null {
    const exclusive = this.#sql<{ time: number | null }>(
      "SELECT MIN(time) AS time FROM cf_agents_jobs WHERE exclusive = 1"
    );
    if (exclusive[0]?.time !== null && exclusive[0]?.time !== undefined) {
      return exclusive[0].time;
    }

    const now = Math.floor(nowMs);
    let candidate: number | null = null;

    const ready = this.#sql<{ time: number | null }>(
      `SELECT MIN(time) AS time FROM cf_agents_jobs
       WHERE singleflight = 0
          OR running = 0
          OR coalesce(execution_started_at, 0) + coalesce(hung_timeout_seconds, ?) * 1000 <= ?`,
      DEFAULT_HUNG_TIMEOUT_SECONDS,
      now
    );
    if (ready[0]?.time !== null && ready[0]?.time !== undefined) {
      candidate = Math.max(ready[0].time, now + 1);
    }

    const inFlight = this.#sql<{ recheck: number | null }>(
      `SELECT MIN(coalesce(execution_started_at, 0) + coalesce(hung_timeout_seconds, ?) * 1000) AS recheck
       FROM cf_agents_jobs
       WHERE singleflight = 1
         AND running = 1
         AND coalesce(execution_started_at, 0) + coalesce(hung_timeout_seconds, ?) * 1000 > ?`,
      DEFAULT_HUNG_TIMEOUT_SECONDS,
      DEFAULT_HUNG_TIMEOUT_SECONDS,
      now
    );
    const recheck = inFlight[0]?.recheck;
    if (recheck !== null && recheck !== undefined) {
      candidate = candidate === null ? recheck : Math.min(candidate, recheck);
    }

    return candidate;
  }
}
