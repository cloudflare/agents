/**
 * Bounds for automatic agent delivery within one delivery cycle.
 *
 * A delivery cycle starts at acceptance and, after terminal failure, restarts
 * at each authorized manual replay. Limits apply to the current cycle so a
 * replay grants a fresh retry budget without erasing prior attempt history.
 */
export interface DeliveryPolicy {
  /** Delay before the first retry, doubled on each later retry. */
  baseRetryDelayMs: number;
  /** Upper bound applied to the exponential schedule before jitter. */
  maxRetryDelayMs: number;
  /** Physical attempts permitted per delivery cycle before terminal failure. */
  maxAttemptsPerCycle: number;
  /** Age of the delivery cycle after which no further attempt may start. */
  maxCycleAgeMs: number;
  /** How long one claimed attempt may run before its lease can be recovered. */
  leaseDurationMs: number;
}

/** Defaults chosen for webhook-scale inbound traffic. */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = {
  baseRetryDelayMs: 1_000,
  maxRetryDelayMs: 60_000,
  maxAttemptsPerCycle: 8,
  maxCycleAgeMs: 24 * 60 * 60 * 1_000,
  leaseDurationMs: 30_000
};

/**
 * Compute the delay before the next attempt using bounded exponential backoff
 * with equal jitter: the capped exponential delay is halved and a random share
 * of that half is added, keeping the result within [cap / 2, cap].
 *
 * @param priorRetryCount Retries already scheduled in this delivery cycle.
 * @param random Injected uniform [0, 1) source so schedules are testable.
 */
export function retryDelayMs(
  policy: DeliveryPolicy,
  priorRetryCount: number,
  random: () => number
): number {
  const exponential = policy.baseRetryDelayMs * 2 ** priorRetryCount;
  const capped = Math.min(policy.maxRetryDelayMs, exponential);
  const half = capped / 2;
  return Math.round(half + random() * half);
}
