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

import { AsyncLocalStorage } from "node:async_hooks";
import {
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
  isPlatformFailure,
  tryN
} from "../retries";
import type { MemoryLimitContext } from "./capability-runner";
import {
  hungTimeoutMs,
  isHungRow,
  jobFromRow,
  type JobQueue,
  type JobStorageRow,
  type LifecycleJob,
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
  /** Capability and host domain policy applied on each memory-limit strike. */
  readonly onMemoryLimit: (context: MemoryLimitContext) => void | Promise<void>;
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

/** The dispatch an async flow belongs to while an alarm drives it. */
type AlarmScope = { readonly executing: JobStorageRow | undefined };

/** One recorded memory-limit strike, shared by every flow that observed it. */
type MemoryLimitStrike = {
  readonly strikes: number;
  readonly limit: number;
  readonly sealed: boolean;
  /** The backoff wake time armed for an unsealed strike. */
  readonly nextTime: number | undefined;
  /** Recovery-loop jobs purged by a sealing strike, snapshotted beforehand. */
  readonly purgedRecoveryLoopJobs: LifecycleJob[] | undefined;
};

/** @internal Drives the job queue when the Durable Object alarm fires. */
export class JobDriver {
  readonly #options: JobDriverOptions;
  /**
   * Ambient dispatch identity for `trackAlarmWork`. Read through the async
   * flow rather than an instance slot so attribution stays correct when
   * alarm invocations overlap (tests drive `alarm()` by hand while the
   * platform fires its own).
   */
  readonly #alarmScope = new AsyncLocalStorage<AlarmScope>();
  #executingRow: JobStorageRow | undefined;
  #alarmsInFlight = 0;
  /**
   * Work handed off by alarm-driven jobs that has not settled yet. While it
   * is non-empty the alarm domain is not quiescent, so a clean alarm must not
   * clear the strike counter: a still-running handoff may yet report the
   * memory reset that alarm started.
   */
  readonly #outstandingAlarmWork = new Set<Promise<unknown>>();
  /**
   * The strike being recorded for the current memory-limit event. One reset
   * is often observed by several flows (an in-alarm job plus handed-off work,
   * or several handoffs awaiting the same condemned storage); they share this
   * record so the counter moves once per event. Cleared by a clean,
   * quiescent classification.
   */
  #strike: Promise<MemoryLimitStrike> | undefined;

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
    this.#alarmsInFlight++;
    try {
      await initialize();
      await this.#driveDueJobs();
      await this.#alarmScope.run({ executing: undefined }, runHostAlarm);
      await this.#clearMemoryLimitStrikesWhenQuiescent();
    } catch (error) {
      if (!isDurableObjectMemoryLimitReset(error)) throw error;
      const executing = this.#executingRow;
      this.#executingRow = undefined;
      await this.#handleMemoryLimitReset(error, executing);
      return;
    } finally {
      this.#alarmsInFlight--;
    }
    await this.#options.rearm();
  }

  /**
   * Keep work a job handed off at a bounded return inside this alarm's
   * memory-limit breaker domain (#1825). The alarm itself returns promptly,
   * so other jobs stay live; the handoff is classified when it settles. A
   * memory-limit reset it reports records a strike against the job that
   * handed it off, exactly as an in-alarm reset would. Strikes clear only
   * once no handed-off work is outstanding and the last of it settled clean.
   *
   * @returns True when called from an alarm-driven dispatch or the host
   * alarm hook; false otherwise, in which case nothing is tracked. Tracking
   * the same promise again (a claim-backstop wake for an attempt already
   * handed off) is a no-op.
   */
  trackAlarmWork(work: Promise<unknown>): boolean {
    const scope = this.#alarmScope.getStore();
    if (!scope) return false;
    if (this.#outstandingAlarmWork.has(work)) return true;
    this.#outstandingAlarmWork.add(work);
    void work.then(
      () => this.#settleAlarmWork(work, undefined, scope.executing),
      (error) => this.#settleAlarmWork(work, error, scope.executing)
    );
    return true;
  }

  async #settleAlarmWork(
    work: Promise<unknown>,
    error: unknown,
    executing: JobStorageRow | undefined
  ): Promise<void> {
    try {
      if (this.#options.disabled()) return;
      if (isDurableObjectMemoryLimitReset(error)) {
        // Still outstanding while the strike is recorded, so an alarm
        // finishing concurrently cannot clear it from underneath.
        await this.#handleMemoryLimitReset(error, executing);
        return;
      }
    } finally {
      this.#outstandingAlarmWork.delete(work);
    }
    // An alarm in flight classifies at its own end.
    if (this.#alarmsInFlight === 0) {
      await this.#clearMemoryLimitStrikesWhenQuiescent();
    }
  }

  async #clearMemoryLimitStrikesWhenQuiescent(): Promise<void> {
    if (this.#outstandingAlarmWork.size > 0) return;
    this.#strike = undefined;
    await this.#clearMemoryLimitStrikes();
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

    for (const stale of due) {
      // Host teardown mid-phase: its storage is gone, stop touching it.
      if (this.#options.disabled()) return;

      // Refetch before claiming: an earlier dispatch in this loop may have
      // pushed, rescheduled, or cancelled this job since the due snapshot
      // was taken. A row that is gone or no longer due belongs to that
      // newer intent — skip it (the final re-arm owns any future wake). A
      // row that changed but is still due dispatches with its fresh data.
      const row = this.#options.queue.dueRow(stale.id, nowMs);
      if (!row) continue;

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
      outcome = await this.#alarmScope.run({ executing: row }, () =>
        tryN(maxAttempts, (attempt) => dispatch.onJob({ job, attempt }), {
          baseDelayMs: job.retry?.baseDelayMs ?? DEFAULT_JOB_RETRY.baseDelayMs,
          maxDelayMs: job.retry?.maxDelayMs ?? DEFAULT_JOB_RETRY.maxDelayMs,
          // In-process retries are futile on a superseded isolate (code
          // never reloads mid-invocation) and on a memory-limit reset (the
          // isolate is condemned, and a retry can read half-claimed state
          // as "nothing to do", converting the reset into a silent success
          // that the breaker never sees). Defer both to the alarm boundary.
          shouldRetry: (error) =>
            !isDurableObjectCodeUpdateReset(error) &&
            !isDurableObjectMemoryLimitReset(error)
        })
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
   * tolerates a few consecutive resets — backing off the executing job and
   * every pending recovery-loop job so the retry is not a hot loop — then
   * seals: those jobs are purged and the capability + host memory-limit
   * policy hooks run.
   *
   * One reset is one event even when several flows observe it. The strike
   * is recorded once per event ({@link #recordMemoryLimitStrike}); every
   * observer then applies the per-job policy for the job it belongs to, and
   * the first observer finishes the event by re-arming, syncing, and
   * resetting the isolate. Each step is best-effort: even these small writes
   * can OOM, but swallowing still halts the platform's auto-retry, and a
   * later wake re-arms legitimate work.
   */
  async #handleMemoryLimitReset(
    error: unknown,
    executing: JobStorageRow | undefined
  ): Promise<void> {
    const { queue } = this.#options;
    const first = this.#strike === undefined;
    this.#strike ??= this.#recordMemoryLimitStrike(error);
    const strike = await this.#strike;

    try {
      if (executing) {
        if (strike.sealed) {
          queue.delete(executing.id);
        } else if (strike.nextTime !== undefined) {
          queue.retime(executing.id, strike.nextTime);
        }
      }
    } catch {
      // best-effort at a failure boundary
    }

    try {
      await this.#options.onMemoryLimit({
        sealed: strike.sealed,
        nextTime: strike.nextTime,
        executing: executing ? jobFromRow(executing) : undefined,
        purgedRecoveryLoopJobs: first
          ? strike.purgedRecoveryLoopJobs
          : undefined
      });
    } catch {
      // best-effort domain policy; the purge above already broke the loop
    }

    if (!first) return;

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
        `Alarm memory-limit strike ${strike.strikes}/${strike.limit}${strike.sealed ? " (sealed)" : ""}; resetting isolate (#1825)`
      );
    } catch {
      // best-effort
    }
  }

  /**
   * Record one strike durably and apply the queue-wide policy that belongs
   * to the event rather than to any one job: recovery-loop rows back off (or
   * purge) as a pack, a sealing strike resets the counter, and the event is
   * emitted once.
   */
  async #recordMemoryLimitStrike(error: unknown): Promise<MemoryLimitStrike> {
    const { queue, storage } = this.#options;

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
    // Capture routed ownership before sealing deletes the rows. Domain policy
    // runs afterward, when the loop is already broken, and uses this snapshot
    // only to terminalize durable state owned outside the alarm host.
    let purgedRecoveryLoopJobs: LifecycleJob[] | undefined;
    try {
      if (sealed) purgedRecoveryLoopJobs = queue.recoveryLoopJobs();
    } catch {
      // best-effort at a failure boundary
    }

    try {
      // Recovery-loop rows travel as a pack: a doomed loop's sibling rows
      // would re-trigger it on the next wake, so they back off (or purge)
      // together with the row that struck.
      if (sealed) {
        queue.purgeRecoveryLoopJobs();
      } else if (nextTime !== undefined) {
        queue.delayRecoveryLoopJobs(nextTime);
      }
    } catch {
      // best-effort at a failure boundary
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

    return { strikes, limit, sealed, nextTime, purgedRecoveryLoopJobs };
  }
}
