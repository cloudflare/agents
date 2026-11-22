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
  isDurableObjectResetError,
  isPlatformFailure,
  tryN
} from "../retries";
import type { MemoryLimitContext } from "./capability-runner";
import {
  hungTimeoutMs,
  isHungRow,
  jobFromRow,
  type JobClaim,
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

/** A retry found its job cancelled or replaced, so it did not run. */
const SUPERSEDED = Symbol("superseded");

/**
 * Attempts that may end with their isolate (no error reported) before the
 * job counts as exhausted, at least. A deploy that resets the isolate also
 * leaves an attempt unreported, so a job with `maxAttempts: 1` still gets a
 * few before its owner is told it failed.
 */
const MIN_UNREPORTED_ATTEMPTS = 3;

/** Longest wait between attempts of a job whose attempts ran out. */
const MAX_EXHAUSTED_BACKOFF_MS = 60 * 60_000;

/** Wait before the next attempt of a job `over` attempts past its budget. */
function exhaustedBackoffMs(over: number): number {
  return Math.min(
    MAX_EXHAUSTED_BACKOFF_MS,
    DEADMAN_ALARM_DELAY_MS * 2 ** Math.min(over, 10)
  );
}

/**
 * The error a job's owner sees in `onJobError` when its attempts ran out
 * without one reporting back: each ended with the isolate (a reset, the CPU
 * or wall-time limit), so no error reached the driver.
 */
function attemptsExhaustedError(row: JobStorageRow): Error {
  const error = new Error(
    `Job ${row.id} (${row.capability}/${row.fn}) started ${row.attempts} ` +
      `attempts that never reported back; each ended with its isolate (a ` +
      `reset, or the CPU or wall-time limit)`
  );
  error.name = "JobAttemptsExhaustedError";
  return error;
}

/**
 * Owners whose jobs a transient platform failure held back in this alarm.
 * Their due jobs keep their times (so a Queue keeps its order) and wait
 * until `until`; everything else re-arms as usual.
 */
export type JobDeferral = {
  readonly owners: readonly string[];
  readonly until: number;
};

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
  /**
   * Arm a fallback wake directly (the startup fallback and the deadman). A
   * root writes its alarm; a facet, which has no alarm, does nothing: its
   * root's wake job for it stays until the facet's reply re-arms it, so it
   * is the facet's fallback.
   */
  readonly armFallback: (time: number) => Promise<void>;
  /** Recompute the physical alarm from queue state. */
  readonly rearm: (deferral?: JobDeferral) => Promise<void>;
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

/**
 * Carries the row a platform failure escaped from out to `runAlarm`'s catch,
 * across the rethrow from `#driveJob`. Attribution must not live in a shared
 * instance field: overlapping `alarm()` invocations (a deadman or the
 * platform's own re-fire racing a still-running invocation) dispatch jobs
 * concurrently, and a field would let a later dispatch overwrite the row an
 * earlier one is still unwinding for.
 */
class AttributedPlatformFailure {
  constructor(
    readonly row: JobStorageRow,
    readonly cause: unknown
  ) {}
}

/** What a drive held back after a transient platform failure. */
type DeferredDrive = {
  readonly failure: AttributedPlatformFailure;
  readonly owners: Set<string>;
};

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
  #alarmsInFlight = 0;
  /**
   * Owners held back after a transient platform failure, with the time the
   * hold ends. In memory: an alarm for another owner inside the hold skips
   * them too, and an eviction just lets them run again.
   */
  readonly #heldOwners = new Map<string, number>();
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
  /**
   * Once a strike has been fully recorded in this isolate, no later
   * settlement may clear the durable counter — a slower, unrelated clean
   * sibling finishing after the strike (but before the isolate reset it
   * scheduled actually lands) must not erase what was just recorded. The
   * isolate reset always follows a recorded strike, so the next genuinely
   * clean cycle runs in a fresh isolate with a fresh `JobDriver` and this
   * flag back at its default; there is no cross-isolate state to reset.
   */
  #strikeRecordedThisIsolate = false;

  constructor(options: JobDriverOptions) {
    this.#options = options;
  }

  /**
   * Run one alarm invocation: arm a startup fallback wake, initialize the
   * lifecycle, drive due jobs, run the host's alarm callback, and re-arm the
   * physical alarm from queue state — all inside the alarm memory-limit
   * circuit breaker (#1825). A memory-limit reset that propagates here is
   * intercepted — every other error re-throws unchanged so platform
   * alarm-retry semantics hold — and broken from this outermost frame, where
   * the heavy turn has unwound and small writes can land. Initialization
   * runs inside the breaker because a severe reset can be thrown before any
   * job runs (boot hydration, #1825); left unhandled it would re-throw to
   * the platform, which auto-retries the alarm forever.
   */
  async runAlarm(
    initialize: () => Promise<void>,
    runHostAlarm: () => Promise<void>
  ): Promise<void> {
    this.#alarmsInFlight++;
    // Only a clean pass (no memory-limit reset seen by this invocation
    // itself) is ever eligible to trigger the quiescence-clear check below —
    // a pass that just recorded a strike must not immediately re-check
    // quiescence and undo what it just set. Reaching quiescence again is a
    // job for some LATER, genuinely clean invocation or handoff settlement.
    let clean = false;
    let deferred: DeferredDrive | undefined;
    try {
      try {
        await this.armStartupFallback();
        await initialize();
        deferred = await this.#driveDueJobs();
        await this.#alarmScope.run({ executing: undefined }, runHostAlarm);
        clean = true;
      } catch (error) {
        // A platform failure from #driveJob carries its row out of the
        // rethrow; anything else (initialize/runHostAlarm) has no job to
        // attribute. Unwrap either way before classifying the real error.
        const attributed = error instanceof AttributedPlatformFailure;
        const cause = attributed ? error.cause : error;
        if (!isDurableObjectMemoryLimitReset(cause)) {
          throw attributed ? cause : error;
        }
        await this.#handleMemoryLimitReset(
          cause,
          attributed ? error.row : undefined
        );
        return;
      }
    } finally {
      // Re-check quiescence exactly when this alarm's own "in flight" status
      // ends, using the freshest counters — one of the two points (the
      // other is a handoff settling, see #settleAlarmWork) that must not be
      // skipped: whichever transition happens last is what performs the
      // clear, and each transition re-evaluates both conditions itself
      // rather than trusting a stale snapshot taken before the other side's
      // own transition landed.
      this.#alarmsInFlight--;
      if (clean) await this.#clearMemoryLimitStrikesWhenQuiescent();
    }
    await this.#options.rearm(this.currentDeferral());
    // A job deferred on a transient platform failure still fails the alarm,
    // so the failure is visible to the platform. The alarm re-armed above
    // wins over the platform's own retry, so this never spends its
    // six-retry budget (RUNTIME-FACTS, 22 Nov).
    if (deferred) throw deferred.failure.cause;
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
    // This settle is itself a quiescence transition — re-check freshly
    // rather than trusting whether an alarm looked in flight before this
    // delete landed (see runAlarm's matching call for why neither side may
    // skip its own check).
    await this.#clearMemoryLimitStrikesWhenQuiescent();
  }

  /**
   * Clear the strike counter once the alarm domain is fully quiescent: no
   * alarm invocation in flight, no handed-off work outstanding, and no
   * strike recorded in this isolate that a fresh isolate hasn't yet
   * superseded. Called at every transition that could make either counter
   * newly zero (an alarm ending, a handoff settling) — each call re-reads
   * both fresh, so whichever transition happens last is the one that
   * performs the clear. Idempotent: redundant calls no-op.
   */
  async #clearMemoryLimitStrikesWhenQuiescent(): Promise<void> {
    if (this.#alarmsInFlight > 0) return;
    if (this.#outstandingAlarmWork.size > 0) return;
    if (this.#strikeRecordedThisIsolate) return;
    this.#strike = undefined;
    await this.#clearMemoryLimitStrikes();
  }

  /**
   * Arm a startup fallback alarm while the queue holds jobs. An alarm arms
   * one before startup runs: the platform clears the alarm when it fires, so
   * a startup that throws (or an isolate that dies mid-startup) would
   * otherwise leave the queue with no wake but the platform's own few, short
   * retries. Lifecycle arms one again after a failed startup that pushed or
   * re-timed jobs, whose deferred re-arm never ran. The fallback keeps the
   * object woken whether or not the platform's retries run: a failed startup
   * is retried at the fallback time. A clean alarm's final re-arm, or any
   * later queue mutation's, replaces it.
   *
   * The fallback is the queue's own next wake, but never sooner than the
   * deadman delay: an overdue job would otherwise make a failing startup
   * retry in a tight loop.
   */
  async armStartupFallback(): Promise<void> {
    if (this.#options.disabled()) return;
    const nowMs = Date.now();
    const next = this.#options.queue.nextAlarmTime(nowMs);
    if (next === null) return;
    await this.#options.armFallback(
      Math.max(next, nowMs + DEADMAN_ALARM_DELAY_MS)
    );
  }

  /**
   * The owners still held back, re-armed no sooner than the earliest end.
   * Every re-arm uses it, so a push during a hold does not wake the object
   * early for a held owner's overdue job.
   */
  currentDeferral(): JobDeferral | undefined {
    const now = Date.now();
    for (const [owner, until] of this.#heldOwners) {
      if (until <= now) this.#heldOwners.delete(owner);
    }
    if (this.#heldOwners.size === 0) return undefined;
    return {
      owners: [...this.#heldOwners.keys()],
      until: Math.min(...this.#heldOwners.values())
    };
  }

  /**
   * Drive every due job once, in due-time order. A transient platform
   * failure holds back its owner's remaining due jobs (an owner such as
   * Queue relies on their order) but not other owners'; the first failure
   * and the held owners are returned so the alarm can re-arm around them and
   * report the failure.
   */
  async #driveDueJobs(): Promise<DeferredDrive | undefined> {
    const nowMs = Date.now();
    const due = this.#options.queue.due(nowMs);
    if (due.length === 0) return undefined;
    let deferred: DeferredDrive | undefined;
    this.#warnBacklog(due);
    // Owners held for this whole scan: those held when it starts, and any a
    // failure holds during it. A hold that ends mid-scan must not let a
    // later job of that owner run ahead of the head it skipped; the re-arm
    // at the end starts a fresh scan from the head.
    const skip = new Set(this.currentDeferral()?.owners);

    // Deadman pre-arm: before driving any job, arm a fallback alarm so a
    // death mid-drive that the platform cannot retry (or that swallows its
    // error) still wakes this object to resume. The normal re-arm at the end
    // of the alarm phase overwrites it.
    if (!this.#options.disabled()) {
      await this.#options.armFallback(nowMs + DEADMAN_ALARM_DELAY_MS);
    }

    for (const stale of due) {
      // Host teardown mid-phase: its storage is gone, stop touching it.
      if (this.#options.disabled()) return deferred;

      // Refetch before claiming: an earlier dispatch in this loop may have
      // pushed, rescheduled, or cancelled this job since the due snapshot
      // was taken. A row that is gone or no longer due belongs to that
      // newer intent — skip it (the final re-arm owns any future wake). A
      // row that changed but is still due dispatches with its fresh data.
      const row = this.#options.queue.dueRow(stale.id, nowMs);
      if (!row) continue;
      if (skip.has(row.capability)) continue;

      let takeover = false;
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
        takeover = true;
      }
      // The claim's revision lets a cancel, push, reschedule or hung
      // takeover made mid-dispatch supersede this dispatch's retries and
      // drive result (see JobQueue.applyOutcome). The running marker it
      // sets feeds single-flight skipping and hung recovery.
      const claim = this.#options.queue.claim(row.id, nowMs, takeover);
      try {
        const failure = await this.#driveJob(row, claim);
        if (failure) {
          deferred ??= { failure, owners: new Set() };
          deferred.owners.add(row.capability);
          skip.add(row.capability);
          this.#heldOwners.set(
            row.capability,
            Date.now() + DEADMAN_ALARM_DELAY_MS
          );
        }
      } finally {
        this.#options.queue.release(claim);
      }
    }
    return deferred;
  }

  /**
   * Dispatch one due row to its owner with retry and failure policy.
   *
   * The row's `attempts` column counts attempts that started and never
   * reported back. Each attempt adds one, and the write is started, before
   * `onJob` runs; any end the driver sees (a result, an application error,
   * a platform failure) takes it off again. So only an attempt that took its
   * isolate down (CPU or wall-time limit, reset) stays counted. Once
   * `max(maxAttempts, 3)` have, the job goes to `onJobError` instead of
   * running again. Without that, such a job re-ran on every fallback alarm
   * forever (RUNTIME-FACTS, 22 Nov). Application retries within one
   * invocation are bounded by `maxAttempts` as before.
   *
   * @returns A transient platform failure this job was deferred on, for
   * the alarm to report once every other due job had its turn. A reset or
   * memory-limit failure throws instead: the isolate is condemned, so the
   * remaining jobs would fail too.
   */
  async #driveJob(
    row: JobStorageRow,
    claim: JobClaim
  ): Promise<AttributedPlatformFailure | undefined> {
    const { queue, resolveDispatch, disabled } = this.#options;
    // Whether the job is still the one this dispatch claimed: no cancel,
    // push, reschedule or hung takeover changed it since.
    const owned = () => queue.isCurrent(claim);
    const job = jobFromRow(row);
    const dispatch = await resolveDispatch(row.capability);
    if (!dispatch) {
      console.error(
        `No installed capability or host handler for job ${row.id} ` +
          `(owner ${JSON.stringify(row.capability)}); dropping it`
      );
      queue.delete(row.id);
      return undefined;
    }

    const maxAttempts = job.retry?.maxAttempts ?? DEFAULT_JOB_RETRY.maxAttempts;
    const prior = row.attempts ?? 0;
    const unreportedLimit = Math.max(maxAttempts, MIN_UNREPORTED_ATTEMPTS);
    if (prior >= unreportedLimit && dispatch.onJobError) {
      // Every attempt so far ended with its isolate; running it again would
      // most likely end the same way. The owner decides what happens.
      let outcome: LifecycleJobOutcome | void = undefined;
      try {
        outcome = await dispatch.onJobError?.(
          { job, attempt: prior },
          attemptsExhaustedError(row)
        );
      } catch (hookError) {
        console.error(`Job failure hook threw for ${row.id}`, hookError);
      }
      if (disabled()) return undefined;
      queue.applyOutcome(claim, outcome ?? undefined);
      return undefined;
    }
    if (prior >= unreportedLimit) {
      // An owner without onJobError keeps its job: deleting it would lose
      // the owner's only wake. Run one attempt at a time, each starting
      // further out, so a job that keeps taking its isolate down costs one
      // attempt per backoff instead of one every deadman delay.
      queue.setTime(
        row.id,
        Date.now() + exhaustedBackoffMs(prior - unreportedLimit)
      );
    }
    let attempt = prior;

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

    let outcome: LifecycleJobOutcome | void | typeof SUPERSEDED;
    try {
      outcome = await this.#alarmScope.run({ executing: row }, () =>
        tryN(
          // An exhausted job kept for an owner without onJobError gets one
          // attempt per wake; its backoff, not tryN, spaces them.
          prior >= unreportedLimit ? 1 : maxAttempts,
          async (local) => {
            // A retry waits in tryN's backoff, and requests run meanwhile.
            // A cancel or same-id push made then is newer intent: do not
            // run the job this dispatch captured again.
            if (local > 1 && !owned()) return SUPERSEDED;
            attempt = prior + local;
            // The claim counted the first try; a retry counts again after
            // the failure before it took its count off.
            if (local > 1) queue.setAttempts(row.id, prior + 1);
            // One macrotask lets the output gate start writing the count, and
            // a write that started survives a CPU-limit kill or abort that
            // follows. Awaiting microtasks is not enough, and
            // `storage.sync()` costs a durable round trip (about 38 ms) per
            // dispatch (RUNTIME-FACTS, 22 Nov).
            await new Promise((resolve) => setTimeout(resolve, 0));
            // The wait let requests run: a cancel or same-id push made
            // meanwhile is newer intent.
            if (disabled() || !owned()) return SUPERSEDED;
            try {
              return await dispatch.onJob({ job, attempt });
            } catch (error) {
              // The attempt reported back: it no longer counts as one that
              // ended with its isolate.
              try {
                if (owned()) queue.setAttempts(row.id, prior);
              } catch {
                // a condemned isolate's storage; the count stays
              }
              throw error;
            }
          },
          {
            baseDelayMs:
              job.retry?.baseDelayMs ?? DEFAULT_JOB_RETRY.baseDelayMs,
            maxDelayMs: job.retry?.maxDelayMs ?? DEFAULT_JOB_RETRY.maxDelayMs,
            // In-process retries are futile on a superseded isolate (code
            // never reloads mid-invocation) and on a memory-limit reset (the
            // isolate is condemned, and a retry can read half-claimed state
            // as "nothing to do", converting the reset into a silent success
            // that the breaker never sees). Defer both to the alarm boundary.
            shouldRetry: (error) =>
              !isDurableObjectCodeUpdateReset(error) &&
              !isDurableObjectMemoryLimitReset(error)
          }
        )
      );
    } catch (error) {
      if (disabled()) return undefined;
      if (isPlatformFailure(error)) {
        // Carry the row out with the error rather than through a shared
        // field: an overlapping alarm's own #driveJob may already be
        // dispatching a different row by the time this unwinds to
        // runAlarm's catch.
        const failure = new AttributedPlatformFailure(row, error);
        if (
          isDurableObjectMemoryLimitReset(error) ||
          isDurableObjectResetError(error)
        ) {
          // The isolate is condemned: preserve the job and stop here, so
          // the memory-limit breaker engages at the alarm boundary or a
          // fresh isolate picks the queue up. Best-effort dispatch-marker
          // reset so the preserved job is not mistaken for one still in
          // flight (and a single-flight job does not wait out its hung
          // timeout first).
          try {
            if (owned()) queue.clearRunning(row.id);
          } catch {
            // the hung timeout eventually recovers the flag
          }
          console.warn(
            `Deferring job ${row.id} to a fresh invocation after a ` +
              `platform failure; the job is preserved.`
          );
          throw failure;
        }
        // A transient failure of something this job called (a stub that
        // lost its connection, a retryable error). Keep the job where it is
        // in its owner's order; the alarm holds this owner back for the
        // deadman delay and goes on with the other owners' jobs.
        try {
          if (owned()) queue.clearRunning(row.id);
        } catch {
          // the hung timeout eventually recovers the flag
        }
        console.warn(
          `Deferring job ${row.id} and the rest of ` +
            `${JSON.stringify(row.capability)}'s due jobs by ` +
            `${DEADMAN_ALARM_DELAY_MS / 1000}s after a platform failure; ` +
            `the jobs are preserved.`
        );
        return failure;
      }
      // Application failure after retry exhaustion: the owner observes it
      // and decides advancement; default is completion.
      try {
        outcome = await dispatch.onJobError?.({ job, attempt }, error);
      } catch (hookError) {
        console.error(`Job failure hook threw for ${row.id}`, hookError);
      }
    } finally {
      clearTimeout(slowWatchdog);
    }

    if (disabled()) return undefined;
    if (outcome === SUPERSEDED) return undefined;
    queue.applyOutcome(claim, outcome ?? undefined);
    return undefined;
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
    // Set before the first await below: closes the window as tightly as
    // possible against a still-outstanding clean sibling reaching quiescence
    // and clearing what this event is about to record.
    this.#strikeRecordedThisIsolate = true;
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
    let counted = true;
    try {
      const prior = await storage.get<number>(OOM_ALARM_STRIKES_KEY);
      strikes = (typeof prior === "number" ? prior : 0) + 1;
      await storage.put(OOM_ALARM_STRIKES_KEY, strikes);
    } catch {
      // The reset isolate's storage rejects every call, so this strike cannot
      // be counted and the counter cannot reach the seal from here. Chat
      // recovery bounds that loop itself: the next isolate counts the
      // interrupted attempt before re-running it (#2613).
      counted = false;
    }

    const limit =
      this.#options.maxMemoryLimitStrikes() ??
      DEFAULT_MAX_ALARM_MEMORY_LIMIT_STRIKES;
    const sealed = strikes >= limit;
    const strikeLabel = counted
      ? `strike ${strikes}/${limit}`
      : "strike not counted: storage rejected it after the reset";
    console.error(
      `Alarm hit a Durable Object memory-limit reset (${strikeLabel}` +
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
