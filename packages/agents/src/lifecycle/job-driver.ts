/**
 * Alarm event loop for the Lifecycle job queue.
 *
 * The driver owns everything that happens when the physical alarm fires:
 * the deadman pre-arm, driving due jobs in due order (single-flight skip and
 * hung recovery, per-job retries, platform-failure deferral, terminal
 * failure hooks), the backlog warning, and the alarm memory-limit circuit
 * breaker (#1825). Lifecycle wires it to the host and capabilities through
 * the narrow {@link JobDriverOptions} contract and keeps only the alarm
 * entry point itself.
 */

import {
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
  isPlatformFailure,
  tryN
} from "../retries";
import {
  hungTimeoutMs,
  isHungRow,
  jobFromRow,
  type JobQueue,
  type JobStorageRow,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "./job-queue";

/** Default consecutive memory-limit strikes tolerated before sealing. */
const DEFAULT_MAX_ALARM_MEMORY_LIMIT_STRIKES = 3;

/** Durable storage key for the alarm memory-limit strike counter (#1825). */
const OOM_ALARM_STRIKES_KEY = "cf_agents:oom_alarm_strikes";

/** Default retry policy applied to jobs pushed without one. */
const DEFAULT_JOB_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 3000
} as const;

/** Due jobs for one capability above this count log a backlog warning. */
const JOB_BACKLOG_WARNING_THRESHOLD = 10;

/**
 * Deadman pre-arm delay: armed before the event loop drives due jobs so an
 * isolate death mid-drive still wakes this object to resume its queue.
 */
const DEADMAN_ALARM_DELAY_MS = 30_000;

/** The dispatch hooks one job owner exposes to the driver. */
export type JobDispatch = {
  readonly onJob: (
    context: LifecycleJobContext
  ) => Promise<LifecycleJobOutcome | void>;
  readonly onJobError?: (
    context: LifecycleJobContext,
    error: unknown
  ) => Promise<LifecycleJobOutcome | void>;
};

/** What the driver needs from its owning Lifecycle. */
export type JobDriverOptions = {
  readonly queue: JobQueue;
  readonly storage: DurableObjectStorage;
  /** Live teardown flag: once true, stop touching storage mid-phase. */
  readonly disabled: () => boolean;
  /** Resolve a job owner to its dispatch hooks, `undefined` when missing. */
  readonly resolveDispatch: (owner: string) => Promise<JobDispatch | undefined>;
  /** Consecutive memory-limit strikes tolerated before sealing (#1825). */
  readonly maxMemoryLimitStrikes: () => number | undefined;
  /** Host domain policy applied on each memory-limit strike. */
  readonly onMemoryLimit: (context: {
    readonly sealed: boolean;
    readonly nextTime?: number;
  }) => void | Promise<void>;
  /** Best-effort lifecycle telemetry. */
  readonly emit: (type: string, payload: unknown) => void;
  /** Recompute the physical alarm from queue state. */
  readonly rearm: () => Promise<void>;
  /**
   * Schedule an isolate reset after a memory-limit strike is fully
   * recorded, suppressing any retry of the current alarm. Returns
   * immediately; the reset lands after the invocation settles, and the next
   * wake is the backoff alarm the strike armed.
   */
  readonly reset: (reason: string) => void;
};

/** @internal Drives the job queue when the Durable Object alarm fires. */
export class JobDriver {
  readonly #options: JobDriverOptions;
  #executingRow: JobStorageRow | undefined;

  constructor(options: JobDriverOptions) {
    this.#options = options;
  }

  /**
   * Run one alarm invocation: initialize the lifecycle, drive due jobs, run
   * the host's alarm callback, and re-arm the physical alarm from queue
   * state — all inside the alarm memory-limit circuit breaker (#1825). A
   * memory-limit reset that propagates here is intercepted — every other
   * error re-throws unchanged so platform alarm-retry semantics hold — and
   * broken from this outermost frame, where the heavy turn has unwound and
   * small writes can land. Initialization runs inside the breaker because a
   * severe reset can be thrown before any job runs (boot hydration, #1825);
   * left unhandled it would re-throw to the platform, which auto-retries
   * the alarm forever.
   */
  async runAlarm(
    initialize: () => Promise<void>,
    runHostAlarm: () => Promise<void>
  ): Promise<void> {
    try {
      await initialize();
      await this.#driveDueJobs();
      await runHostAlarm();
      await this.#clearMemoryLimitStrikes();
    } catch (error) {
      if (!isDurableObjectMemoryLimitReset(error)) throw error;
      await this.#handleMemoryLimitReset(error);
      return;
    }
    await this.#options.rearm();
  }

  /** Drive every due job once, in due-time order. */
  async #driveDueJobs(): Promise<void> {
    const nowMs = Date.now();
    const due = this.#options.queue.due(nowMs);
    if (due.length === 0) return;
    this.#warnBacklog(due);

    // Deadman pre-arm: before driving any job, arm a fallback alarm so a
    // death mid-drive that the platform cannot retry (or that swallows its
    // error) still wakes this object to resume. The normal re-arm at the end
    // of the alarm phase overwrites it.
    if (!this.#options.disabled()) {
      await this.#options.storage.setAlarm(nowMs + DEADMAN_ALARM_DELAY_MS);
    }

    for (const row of due) {
      // Host teardown mid-phase: its storage is gone, stop touching it.
      if (this.#options.disabled()) return;

      if (row.singleflight === 1 && row.running === 1) {
        if (!isHungRow(row, nowMs)) {
          console.warn(
            `Skipping job ${row.id}: previous execution still running`
          );
          continue;
        }
        console.warn(
          `Forcing reset of hung job ${row.id} (started ${Math.round(
            (nowMs - (row.execution_started_at ?? 0)) / 1000
          )}s ago)`
        );
      }
      // Every dispatch is marked, not just single-flight: the marker is
      // what lets a same-id push made mid-dispatch supersede the returned
      // drive result (see JobQueue.applyOutcome).
      this.#options.queue.markRunning(row.id, nowMs);

      await this.#driveJob(row);
    }
  }

  /** Dispatch one due row to its owner with retry and failure policy. */
  async #driveJob(row: JobStorageRow): Promise<void> {
    const { queue, resolveDispatch, disabled } = this.#options;
    const job = jobFromRow(row);
    const dispatch = await resolveDispatch(row.capability);
    if (!dispatch) {
      console.error(
        `No installed capability or host handler for job ${row.id} ` +
          `(owner ${JSON.stringify(row.capability)}); dropping it`
      );
      queue.delete(row.id);
      return;
    }

    const maxAttempts = job.retry?.maxAttempts ?? DEFAULT_JOB_RETRY.maxAttempts;

    // Dispatch must be bounded: the drive loop awaits each job inline, so
    // one long dispatch delays every other job on this object. The queue
    // cannot safely abandon owner code, so the contract is enforced by
    // visibility — a dispatch that outlives the job's hung timeout warns
    // loudly and emits telemetry naming the owner.
    const slowWatchdog = setTimeout(() => {
      const seconds = Math.round(hungTimeoutMs(row) / 1000);
      console.warn(
        `Job ${row.id} (${row.capability}/${row.fn}) has been dispatching ` +
          `for over ${seconds}s. Long dispatches starve every other job on ` +
          `this object; onJob must detach unbounded work and return.`
      );
      try {
        this.#options.emit("job:slow_dispatch", {
          capability: row.capability,
          fn: row.fn,
          id: row.id,
          thresholdMs: hungTimeoutMs(row)
        });
      } catch {
        // telemetry never blocks the dispatch
      }
    }, hungTimeoutMs(row));

    this.#executingRow = row;
    let outcome: LifecycleJobOutcome | void;
    try {
      outcome = await tryN(
        maxAttempts,
        (attempt) => dispatch.onJob({ job, attempt }),
        {
          baseDelayMs: job.retry?.baseDelayMs ?? DEFAULT_JOB_RETRY.baseDelayMs,
          maxDelayMs: job.retry?.maxDelayMs ?? DEFAULT_JOB_RETRY.maxDelayMs,
          // In-process retries are futile on a superseded isolate: code
          // never reloads mid-invocation. Defer to a fresh invocation.
          shouldRetry: (error) => !isDurableObjectCodeUpdateReset(error)
        }
      );
    } catch (error) {
      if (disabled()) return;
      if (isPlatformFailure(error)) {
        // Platform-class failure: preserve the job and re-throw so the
        // platform retries a fresh invocation (or the memory-limit breaker
        // engages at the alarm boundary). Best-effort dispatch-marker reset
        // so the preserved job is not mistaken for one still in flight (and
        // a single-flight job does not wait out its hung timeout first).
        try {
          queue.clearRunning(row.id);
        } catch {
          // the hung timeout eventually recovers the flag
        }
        console.warn(
          `Deferring job ${row.id} to a fresh invocation after a ` +
            `platform failure; the job is preserved.`
        );
        // Leave #executingRow set: the memory-limit breaker at the alarm
        // boundary targets the exact job that was executing.
        throw error;
      }
      // Application failure after retry exhaustion: the owner observes it
      // and decides advancement; default is completion.
      try {
        outcome = await dispatch.onJobError?.(
          { job, attempt: maxAttempts },
          error
        );
      } catch (hookError) {
        console.error(`Job failure hook threw for ${row.id}`, hookError);
      }
    } finally {
      clearTimeout(slowWatchdog);
    }

    if (disabled()) return;
    queue.applyOutcome(row.id, outcome ?? undefined);
    this.#executingRow = undefined;
  }

  #warnBacklog(due: ReadonlyArray<JobStorageRow>): void {
    const counts = new Map<string, number>();
    for (const row of due) {
      counts.set(row.capability, (counts.get(row.capability) ?? 0) + 1);
    }
    for (const [owner, count] of counts) {
      if (count < JOB_BACKLOG_WARNING_THRESHOLD) continue;
      try {
        console.warn(
          `Processing ${count} due jobs for ${JSON.stringify(owner)} ` +
            `in a single alarm cycle. This usually means one-shot jobs are ` +
            `pushed repeatedly without a stable id.`
        );
        this.#options.emit("job:backlog_warning", {
          capability: owner,
          count
        });
      } catch {
        // warning emission never blocks job processing
      }
    }
  }

  /**
   * Clear the durable memory-limit strike counter after a clean alarm so the
   * breaker counts CONSECUTIVE resets rather than lifetime ones (#1825).
   * Reads first and only writes when a strike is recorded. Best-effort.
   */
  async #clearMemoryLimitStrikes(): Promise<void> {
    const { storage } = this.#options;
    try {
      const prior = await storage.get<number>(OOM_ALARM_STRIKES_KEY);
      if (typeof prior === "number" && prior > 0) {
        await storage.delete(OOM_ALARM_STRIKES_KEY);
      }
    } catch {
      // a stale strike only costs one extra tolerated spike later
    }
  }

  /**
   * Alarm-boundary circuit breaker for Durable Object memory-limit resets
   * (#1825). Unhandled, the platform would auto-retry the alarm forever,
   * re-running the doomed work each cycle. A durable strike counter
   * tolerates a few consecutive resets — backing off the executing job so
   * the retry is not a hot loop — then seals: the executing job is purged
   * and the host's memory-limit policy hook runs. Each step is best-effort:
   * even these small writes can OOM, but swallowing still halts the
   * platform's auto-retry, and a later wake re-arms legitimate work.
   */
  async #handleMemoryLimitReset(error: unknown): Promise<void> {
    const { queue, storage } = this.#options;
    const executing = this.#executingRow;
    this.#executingRow = undefined;

    let strikes = 1;
    try {
      const prior = await storage.get<number>(OOM_ALARM_STRIKES_KEY);
      strikes = (typeof prior === "number" ? prior : 0) + 1;
      await storage.put(OOM_ALARM_STRIKES_KEY, strikes);
    } catch {
      // even the strike write OOMed; still progress toward sealing
    }

    const limit =
      this.#options.maxMemoryLimitStrikes() ??
      DEFAULT_MAX_ALARM_MEMORY_LIMIT_STRIKES;
    const sealed = strikes >= limit;
    console.error(
      `Alarm hit a Durable Object memory-limit reset (strike ${strikes}/${limit}` +
        `${sealed ? ", sealing recovery" : ", will retry with backoff"}). ` +
        "Breaking the platform alarm-retry loop (#1825).",
      error instanceof Error ? error.message : String(error)
    );

    const nextTime = sealed
      ? undefined
      : Date.now() + Math.min(300, 30 * strikes) * 1000;

    try {
      if (executing) {
        if (sealed) {
          queue.delete(executing.id);
        } else if (nextTime !== undefined) {
          queue.retime(executing.id, nextTime);
        }
      }
    } catch {
      // best-effort at a failure boundary
    }

    try {
      await this.#options.onMemoryLimit({ sealed, nextTime });
    } catch {
      // best-effort domain policy; the purge above already broke the loop
    }

    if (sealed) {
      try {
        await storage.delete(OOM_ALARM_STRIKES_KEY);
      } catch {
        // best-effort counter reset
      }
    }

    try {
      this.#options.emit("alarm:memory_limit_reset", {
        strikes,
        limit,
        sealed,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // event emission is non-critical
    }

    // Re-arm so unrelated work continues. Wrapped because it can itself OOM;
    // if it does, the next external wake re-arms.
    try {
      await this.#options.rearm();
    } catch {
      // best-effort
    }

    // Finish on a fresh isolate: the strike is durable and the backoff alarm
    // owns the next wake, so schedule a reset to reclaim the memory
    // footprint instead of limping on in the pressured isolate. Sync first —
    // a reset cancels unconfirmed writes, and the strike/backoff writes must
    // land. If any of this fails, fall through to the swallow-and-return
    // exit, which still halts the platform's alarm auto-retry.
    try {
      await this.#options.storage.sync();
      this.#options.reset(
        `Alarm memory-limit strike ${strikes}/${limit}${sealed ? " (sealed)" : ""}; resetting isolate (#1825)`
      );
    } catch {
      // best-effort
    }
  }
}
