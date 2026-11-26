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
import { isNonRetryableError } from "../tasks/errors";
import { TaskSettlement } from "../tasks/settlement";
import type { Tasks } from "../tasks/tasks";
import type { TaskCheckpoint, TaskJson, TaskStep } from "../tasks/types";

/**
 * One attempt of a delivery, as its sink sees it.
 *
 * @internal
 */
export interface DeliveryAttempt {
  /**
   * Progress inside one delivery (a reply posted in parts), read by the next
   * attempt. A write after the attempt timed out throws.
   */
  readonly checkpoint: TaskCheckpoint;
  /**
   * What the sender passed as `local` to {@link sendDelivery}, on the first
   * attempt in the isolate that sent it; `undefined` on any later attempt.
   */
  readonly local: unknown;
}

/**
 * Where deliveries of one kind go. Returning acknowledges the delivery;
 * throwing fails this attempt, and it is tried again with backoff. Throwing
 * a `NonRetryableError` gives the delivery up at once (a receiver that
 * refused it, or a send that may have arrived in part).
 * Returning `"hold"` keeps the delivery, with no deadline, until
 * {@link releaseDelivery} gives it what it waits for.
 *
 * @internal
 */
export interface DeliverySink<Payload> {
  deliver(
    payload: Payload,
    attempt: DeliveryAttempt
  ): void | "hold" | Promise<void | "hold">;
  /** How long one attempt may run before it fails. Default 60 s. */
  attemptTimeoutMs?: number;
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
  onGiveUp?(
    error: Error,
    payload: Payload,
    /** What the delivery's attempts kept, as they left it. */
    progress: Pick<TaskCheckpoint, "get">
  ): void | Promise<void>;
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
/** When a held delivery was released: its give-up window starts there. */
const RELEASED_AT = "__delivery:releasedAt";

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
 * window counts from `sentAt`, its backoff from `attempts`, its checkpoint
 * starts as `progress`, and it waits for the alarm.
 *
 * @internal
 */
export async function sendDelivery<Payload>(
  tasks: Tasks,
  sink: string,
  id: string,
  payload: Payload,
  resume?: {
    sentAt: number;
    attempts: number;
    progress?: Record<string, TaskJson>;
  },
  options: {
    /** Handed to the first attempt in this isolate as `attempt.local`. */
    local?: unknown;
    /**
     * Checkpoint entries the delivery starts with, durable with its row
     * (before any attempt can be cut off). Keys must not be reserved.
     */
    progress?: Record<string, TaskJson>;
    /**
     * Keep the run's row once delivered, so the same id later is still
     * taken as a repeat. Default: deleted on acknowledgement.
     */
    retain?: boolean;
  } = {}
): Promise<void> {
  if (!resume) {
    // The first attempt runs here and now: its claim arms the run's only
    // wake, so the accept writes none.
    await tasks.run(deliveryDefinition(sink), payload, {
      runId: id,
      retain: options.retain ?? false,
      start: "now",
      ...(options.local !== undefined && { local: options.local }),
      ...(options.progress && { checkpoint: options.progress })
    });
    return;
  }
  await tasks.importRun({
    runId: id,
    definition: deliveryDefinition(sink),
    status: "pending",
    attempt: resume.attempts,
    input: payload as TaskJson,
    retain: options.retain ?? false,
    createdAt: resume.sentAt,
    // Its earlier attempts ended (they were the released version's), so
    // none of them counts as lost.
    checkpoint: { ...resume.progress, [ENDED]: resume.attempts }
  });
}

/**
 * Run a held delivery now, with `progress` written to its checkpoint first.
 * Two releases that race run it once.
 *
 * @returns False unless the delivery was held.
 * @internal
 */
export async function releaseDelivery(
  tasks: Tasks,
  id: string,
  progress: Record<string, TaskJson>
): Promise<boolean> {
  // `settle` also takes a run a reset left running; a release must not
  // rewrite the progress of one that is no longer held.
  if (tasks.peek(id)?.waitReason !== "park") return false;
  const now = Date.now();
  return tasks.settle(id, TaskSettlement.retry(now), {
    checkpoint: { ...progress, [RELEASED_AT]: now }
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
      .then(() => sink.onGiveUp?.(error, payload, step.checkpoint))
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
  // A held delivery's window starts when it was released, not while it
  // waited for what to send.
  const outOfTime = (now: number) =>
    now - (step.checkpoint.get<number>(RELEASED_AT) ?? step.createdAt) >=
      GIVE_UP_AFTER_MS ||
    step.attempt >= MAX_DELIVERY_ATTEMPTS - MAX_LOST_ATTEMPTS;

  // Attempts counted (and committed) that never ended: the object reset
  // while they ran. They back off like a failure, without running the
  // sink, and give up after a few in a row; otherwise a sink that resets
  // its object before its first I/O would run again on every start. The
  // time window is not checked here: a delivery gives up on time only when
  // a send failed past it.
  const ended = step.checkpoint.get<number>(ENDED) ?? 0;
  if (step.attempt - 1 > ended) {
    const lost =
      (step.checkpoint.get<number>(LOST) ?? 0) + (step.attempt - 1 - ended);
    const now = Date.now();
    if (
      lost >= MAX_LOST_ATTEMPTS ||
      step.attempt >= MAX_DELIVERY_ATTEMPTS - MAX_LOST_ATTEMPTS
    ) {
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

  const timeoutMs = sink.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Delivery ${step.id} attempt ${step.attempt} timed out after ${timeoutMs}ms`
        )
      );
    }, timeoutMs);
  });
  // A sink that times out keeps running; its later writes throw.
  let live = true;
  const checkpoint: TaskCheckpoint = {
    get: (key) => step.checkpoint.get(key),
    set: (key, value) => {
      if (!live) throw new Error(`Delivery ${step.id}: attempt timed out`);
      if (key.startsWith("__delivery:")) {
        throw new Error(`Delivery checkpoint key "${key}" is reserved`);
      }
      step.checkpoint.set(key, value);
    }
  };
  try {
    const outcome = await Promise.race([
      sink.deliver(payload, { checkpoint, local: step.local }),
      timedOut
    ]);
    if (outcome === "hold") {
      // Ended, so the release's attempt does not count it as lost.
      step.checkpoint.set(ENDED, step.attempt);
      return TaskSettlement.park("hold");
    }
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
    if (outOfTime(now) || isNonRetryableError(error)) return giveUp(error);
    const retry = retryLater(now);
    console.error(
      `[agents] delivery ${step.id} failed (attempt ${step.attempt}); retrying in ${Math.round(((retry.wakeAt ?? now) - now) / 1000)}s`,
      error
    );
    return retry;
  } finally {
    live = false;
    clearTimeout(timer);
  }
}
