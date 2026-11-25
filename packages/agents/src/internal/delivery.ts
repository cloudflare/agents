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
import type { TaskCheckpoint, TaskJson, TaskStep } from "../tasks/types";

/**
 * When a failed delivery is tried again, and when it is given up.
 *
 * @internal
 */
export interface DeliveryRetryPolicy {
  /** The wait after the first failure, doubled after each one. Default 2 s. */
  baseDelayMs?: number;
  /** The longest wait between two attempts. Default 10 minutes. */
  maxDelayMs?: number;
  /**
   * How long after the delivery was sent it is given up: the attempt that
   * fails past it ends the run `error`. Default 12 hours.
   */
  giveUpAfterMs?: number;
  /**
   * How long one attempt may run. A sink still running then fails the
   * attempt (its signal aborts) and the delivery backs off. Default 60 s.
   */
  attemptTimeoutMs?: number;
}

/**
 * One attempt of a delivery, as its sink sees it.
 *
 * @internal
 */
export interface DeliveryAttempt {
  /** The delivery's id: the run id it was sent under. */
  readonly id: string;
  /** 1 for the first attempt. */
  readonly attempt: number;
  /**
   * The same on every attempt of this delivery: the key a receiver dedupes
   * on, since an attempt that failed may still have arrived.
   */
  readonly idempotencyKey: string;
  /** Aborts when the delivery is cancelled or the attempt times out. */
  readonly signal: AbortSignal;
  /**
   * Progress inside one delivery (a reply posted in parts), read by the next
   * attempt. A write of an attempt that timed out is dropped.
   */
  readonly checkpoint: TaskCheckpoint;
}

/**
 * Where deliveries of one kind go. Returning acknowledges the delivery;
 * throwing fails this attempt, and it is tried again with backoff.
 *
 * @internal
 */
export interface DeliverySink<Payload> {
  deliver(payload: Payload, attempt: DeliveryAttempt): void | Promise<void>;
  retry?: DeliveryRetryPolicy;
  /**
   * The error a delivery gives up with; `cause` is the last failure. The
   * run ends `error` with it and Tasks reports it to the host's `onError`.
   * Default: "Delivery <id> gave up after <n> attempts: <cause>".
   */
  giveUpError?(
    payload: Payload,
    id: string,
    attempts: number,
    cause: unknown
  ): Error;
}

const DEFAULT_RETRY: Required<DeliveryRetryPolicy> = {
  baseDelayMs: 2_000,
  maxDelayMs: 10 * 60 * 1000,
  giveUpAfterMs: 12 * 60 * 60 * 1000,
  attemptTimeoutMs: 60_000
};

/**
 * Attempts a delivery may start. Above the ~80 that twelve hours of the
 * default backoff allows; it exists because Tasks commits an attempt
 * before the sink runs only for a capped definition, so a sink that resets
 * the object before its first I/O backs off instead of running again at once.
 */
const MAX_DELIVERY_ATTEMPTS = 200;

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
  const policy = { ...DEFAULT_RETRY, ...sink.retry };
  tasks.register(
    deliveryDefinition(name),
    (input, step) => attemptDelivery(sink, policy, input as Payload, step),
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
    createdAt: resume.sentAt
  });
}

async function attemptDelivery<Payload>(
  sink: DeliverySink<Payload>,
  policy: Required<DeliveryRetryPolicy>,
  payload: Payload,
  step: TaskStep
): Promise<void | TaskSettlement> {
  const timeout = new AbortController();
  const abort = () => timeout.abort(step.signal.reason);
  step.signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `Delivery ${step.id} attempt ${step.attempt} timed out after ${policy.attemptTimeoutMs}ms`
      );
      timeout.abort(error);
      reject(error);
    }, policy.attemptTimeoutMs);
  });
  // A timed-out sink keeps running; its later checkpoint writes are dropped.
  let live = true;
  const checkpoint: TaskCheckpoint = {
    get: (key) => step.checkpoint.get(key),
    set: (key, value) => {
      if (!live) throw new Error(`Delivery ${step.id}: attempt timed out`);
      step.checkpoint.set(key, value);
    }
  };
  try {
    return await Promise.race([
      sink.deliver(payload, {
        id: step.id,
        attempt: step.attempt,
        idempotencyKey: step.idempotencyKey("deliver"),
        signal: timeout.signal,
        checkpoint
      }),
      timedOut
    ]);
  } catch (error) {
    // The isolate is going away: leave the run to the next one.
    if (
      isDurableObjectCodeUpdateReset(error) ||
      isDurableObjectMemoryLimitReset(error)
    ) {
      throw error;
    }
    if (step.signal.aborted) throw error;
    const now = Date.now();
    const next =
      now +
      backoffDelay(step.attempt, {
        baseMs: policy.baseDelayMs,
        maxMs: policy.maxDelayMs
      });
    if (next - step.createdAt > policy.giveUpAfterMs) {
      throw (
        sink.giveUpError?.(payload, step.id, step.attempt, error) ??
        new Error(
          `Delivery ${step.id} gave up after ${step.attempt} attempts: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
    }
    console.error(
      `[agents] delivery ${step.id} failed (attempt ${step.attempt}); retrying in ${Math.round((next - now) / 1000)}s`,
      error
    );
    return TaskSettlement.retry(next);
  } finally {
    live = false;
    clearTimeout(timer);
    step.signal.removeEventListener("abort", abort);
  }
}
