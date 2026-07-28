import type { AgentDeliveryAttempt } from "./agent-delivery-attempts";
import type { AgentDeliveryCoordinator } from "./agent-delivery-coordinator";
import type { SubmissionStore } from "./storage/submission-store";

/**
 * Durable wakeup mechanism for future delivery work. A Durable Object's
 * `ctx.storage` satisfies this interface directly via its alarm API.
 */
export interface DeliveryAlarms {
  /** Persist a wakeup at the given millisecond epoch time. */
  setAlarm(scheduledTimeMs: number): void | Promise<void>;
}

/** Bounds one delivery pass. */
export interface AgentDeliverySchedulerOptions {
  /** Maximum submissions dispatched per {@link AgentDeliveryScheduler.deliverDue} pass. */
  batchLimit?: number;
}

/**
 * Drives durable delivery work from persisted schedule state rather than
 * in-memory timers.
 *
 * Hosts call {@link deliverDue} whenever the runtime wakes up — after
 * acceptance, from a Durable Object alarm, or on any recovery path. Each pass
 * recovers expired leases, dispatches every due submission once, and then
 * re-arms the alarm from {@link SubmissionStore.nextDeliveryEventAt}, so
 * retries still happen after a restart or eviction: the schedule is already
 * durable, and the next wakeup is re-derived from it every time.
 */
export class AgentDeliveryScheduler {
  readonly #store: SubmissionStore;
  readonly #coordinator: AgentDeliveryCoordinator;
  readonly #alarms: DeliveryAlarms | undefined;
  readonly #batchLimit: number;

  constructor(
    store: SubmissionStore,
    coordinator: AgentDeliveryCoordinator,
    alarms?: DeliveryAlarms,
    options: AgentDeliverySchedulerOptions = {}
  ) {
    this.#store = store;
    this.#coordinator = coordinator;
    this.#alarms = alarms;
    this.#batchLimit = options.batchLimit ?? 50;
  }

  /**
   * Runs one delivery pass and re-arms the next durable wakeup.
   *
   * Returns the attempts made in this pass. Submissions that fail again are
   * rescheduled with backoff by the store, so they are picked up by a later
   * pass rather than looped within this one.
   */
  async deliverDue(): Promise<AgentDeliveryAttempt[]> {
    this.#store.recoverExpiredLeases();
    const attempts: AgentDeliveryAttempt[] = [];
    for (const submissionId of this.#store.listDueSubmissions(
      this.#batchLimit
    )) {
      const attempt = await this.#coordinator.dispatch(submissionId);
      if (attempt !== undefined) {
        attempts.push(attempt);
      }
    }
    await this.scheduleNextWake();
    return attempts;
  }

  /**
   * Persists an alarm for the earliest scheduled delivery event, when one
   * exists. Returns that time for observability.
   */
  async scheduleNextWake(): Promise<string | undefined> {
    const next = this.#store.nextDeliveryEventAt();
    if (next !== undefined && this.#alarms !== undefined) {
      await this.#alarms.setAlarm(Date.parse(next));
    }
    return next;
  }
}
