/**
 * Deliveries: a value sent somewhere else, retried with backoff until its
 * sink acknowledges it. A delivery is a Tasks run of the sink's framework
 * definition; this module owns no table, key or job of its own. Design:
 * `design/deliveries.md`.
 *
 * @internal Sibling-package support, not a public API.
 */
import {
  backoffDelay,
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset
} from "../retries";
import { TaskSettlement } from "../tasks/settlement";
import type { Tasks } from "../tasks/tasks";
import type { TaskJson, TaskStep } from "../tasks/types";

/**
 * Where deliveries of one kind go. Returning acknowledges the delivery;
 * throwing fails this attempt, and it is tried again with backoff.
 *
 * @internal
 */
export interface DeliverySink<Payload> {
  deliver(payload: Payload): void | Promise<void>;
  /**
   * The error a delivery gives up with; `cause` is the last failure. The
   * run ends `error` with it. Default: "Delivery <id> gave up after <n>
   * attempts: <cause>".
   */
  giveUpError?(
    payload: Payload,
    id: string,
    attempts: number,
    cause: unknown
  ): Error;
  /**
   * Told once that a delivery gave up. Not awaited: the run ends `error`
   * whatever it does, and a throw or rejection is logged.
   */
  onGiveUp?(error: Error, payload: Payload): void | Promise<void>;
}

/** The wait after the first failure, doubled after each one. */
const BASE_DELAY_MS = 2_000;
/** The longest wait between two attempts. */
const MAX_DELAY_MS = 10 * 60 * 1000;
/** A delivery that fails this long after it was sent is given up. */
const GIVE_UP_AFTER_MS = 12 * 60 * 60 * 1000;
/** A sink still running after this fails its attempt. */
const ATTEMPT_TIMEOUT_MS = 60_000;

/**
 * Attempts a delivery may start. Above the ~80 that twelve hours of
 * backoff allows. It is set because Tasks commits an attempt with
 * `storage.sync()` before the handler only for a capped definition: that is
 * what lets an attempt a reset cut short be counted. The handler gives up
 * before Tasks' own cap, so a give-up is always reported.
 */
const MAX_DELIVERY_ATTEMPTS = 200;

/**
 * Attempts in a row that started and never ended (the object reset before
 * the sink returned or threw) after which a delivery gives up: a sink that
 * kills its isolate every time is not tried forever.
 */
const MAX_LOST_ATTEMPTS = 3;

/**
 * The delivery's checkpoint keys: the last attempt that ended, and the
 * attempts lost in a row before it.
 */
const ENDED = "__delivery:ended";
const LOST = "__delivery:lost";

/** The framework definition of one sink's deliveries. */
export function deliveryDefinition(sink: string): string {
  return `__cf_delivery:${sink}`;
}

/**
 * Register `sink` on `tasks`. Call once per sink from the host's
 * constructor, like any framework definition, so a delivery sent before a
 * reset finds its sink again.
 *
 * @internal
 */
export function registerDeliverySink<Payload>(
  tasks: Tasks,
  name: string,
  sink: DeliverySink<Payload>
): void {
  tasks.register(
    deliveryDefinition(name),
    (input, step) => attemptDelivery(sink, input as Payload, step),
    { maxAttempts: MAX_DELIVERY_ATTEMPTS }
  );
}

/**
 * Send `payload` to `sink` as delivery `id`. A delivery with that id that
 * is still open is joined, not repeated: one delivery per key. Resolves
 * once the first attempt has ended (acknowledged, or waiting to retry);
 * nothing is kept once the delivery is acknowledged.
 *
 * `resume` carries a delivery an earlier version already tried: its give-up
 * window counts from `sentAt`, its backoff from `attempts`, and it waits
 * for the alarm.
 *
 * @internal
 */
export async function sendDelivery<Payload>(
  tasks: Tasks,
  sink: string,
  id: string,
  payload: Payload,
  resume?: { sentAt: number; attempts: number }
): Promise<void> {
  if (!resume) {
    // The first attempt runs here and now: its claim arms the run's only
    // wake, so the accept writes none.
    await tasks.run(deliveryDefinition(sink), payload, {
      runId: id,
      retain: false,
      start: "now"
    });
    return;
  }
  await tasks.importRun({
    runId: id,
    definition: deliveryDefinition(sink),
    status: "pending",
    attempt: resume.attempts,
    input: payload as TaskJson,
    retain: false,
    createdAt: resume.sentAt,
    // Its earlier attempts ended (they were the released version's), so
    // none of them counts as lost.
    checkpoint: { [ENDED]: resume.attempts }
  });
}

async function attemptDelivery<Payload>(
  sink: DeliverySink<Payload>,
  payload: Payload,
  step: TaskStep
): Promise<void | TaskSettlement> {
  const giveUp = (cause: unknown): TaskSettlement => {
    const error =
      sink.giveUpError?.(payload, step.id, step.attempt, cause) ??
      new Error(
        `Delivery ${step.id} gave up after ${step.attempt} attempts: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      );
    console.error(`[agents] ${error.message}`);
    // Not awaited: a hook that never returns must not hold the run open.
    void Promise.resolve()
      .then(() => sink.onGiveUp?.(error, payload))
      .catch((hookError: unknown) => {
        console.error(`[agents] delivery ${step.id} onGiveUp threw`, hookError);
      });
    // Returned, not thrown: Tasks reads some thrown messages (a lost
    // connection) as a platform failure and would keep the run open.
    return TaskSettlement.failed(error);
  };
  const retryLater = (now: number): TaskSettlement =>
    TaskSettlement.retry(
      now +
        backoffDelay(step.attempt, {
          baseMs: BASE_DELAY_MS,
          maxMs: MAX_DELAY_MS
        })
    );
  const outOfTime = (now: number) =>
    now - step.createdAt >= GIVE_UP_AFTER_MS ||
    step.attempt >= MAX_DELIVERY_ATTEMPTS - MAX_LOST_ATTEMPTS;

  // Attempts counted (and committed) that never ended: the object reset
  // while they ran. They back off like a failure, without running the
  // sink, and give up after a few in a row; otherwise a sink that resets
  // its object before its first I/O would run again on every start.
  const ended = step.checkpoint.get<number>(ENDED) ?? 0;
  if (step.attempt - 1 > ended) {
    const lost =
      (step.checkpoint.get<number>(LOST) ?? 0) + (step.attempt - 1 - ended);
    const now = Date.now();
    if (lost >= MAX_LOST_ATTEMPTS || outOfTime(now)) {
      return giveUp(
        new Error(
          `${lost} attempt${lost === 1 ? "" : "s"} in a row never reported back`
        )
      );
    }
    step.checkpoint.set(LOST, lost);
    step.checkpoint.set(ENDED, step.attempt);
    console.error(
      `[agents] delivery ${step.id}: an attempt never reported back (${lost} in a row); backing off`
    );
    return retryLater(now);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Delivery ${step.id} attempt ${step.attempt} timed out after ${ATTEMPT_TIMEOUT_MS}ms`
        )
      );
    }, ATTEMPT_TIMEOUT_MS);
  });
  try {
    // A sink that times out keeps running; its late result is not read.
    await Promise.race([sink.deliver(payload), timedOut]);
    return;
  } catch (error) {
    // The isolate is going away: leave the run to the next one.
    if (
      isDurableObjectCodeUpdateReset(error) ||
      isDurableObjectMemoryLimitReset(error)
    ) {
      throw error;
    }
    if (step.signal.aborted) throw error;
    step.checkpoint.set(ENDED, step.attempt);
    step.checkpoint.set(LOST, 0);
    const now = Date.now();
    if (outOfTime(now)) return giveUp(error);
    const retry = retryLater(now);
    console.error(
      `[agents] delivery ${step.id} failed (attempt ${step.attempt}); retrying in ${Math.round(((retry.wakeAt ?? now) - now) / 1000)}s`,
      error
    );
    return retry;
  } finally {
    clearTimeout(timer);
  }
}
