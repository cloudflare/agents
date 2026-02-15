/**
 * Retry options for schedule(), scheduleEvery(), queue(), and this.retry().
 */
export interface RetryOptions {
  /** Max number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default: 100 */
  baseDelayMs?: number;
  /** Max delay cap in ms. Default: 3000 */
  maxDelayMs?: number;
}

/**
 * Internal options for tryN -- extends RetryOptions with a shouldRetry predicate.
 */
interface TryNOptions extends RetryOptions {
  /**
   * Predicate to determine if an error should be retried.
   * Receives the error and the next attempt number (so callers can
   * make attempt-aware decisions).
   * If not provided, all errors are retried.
   */
  shouldRetry?: (err: unknown, nextAttempt: number) => boolean;
}

/**
 * Validate retry options eagerly so invalid config fails at enqueue/schedule time
 * rather than at execution time. Checks individual field ranges, enforces integer
 * maxAttempts, and validates cross-field constraints after resolving against
 * defaults when provided.
 */
export function validateRetryOptions(
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

  // Resolve against defaults (when provided) so that cross-field checks
  // catch e.g. { baseDelayMs: 5000 } against default maxDelayMs: 3000.
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

/**
 * Returns the number of milliseconds to wait before retrying a request.
 * Uses the "Full Jitter" approach from
 * https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 *
 * @param attempt The current attempt number (1-indexed).
 * @param baseDelayMs Base delay multiplier in ms.
 * @param maxDelayMs Maximum delay cap in ms.
 * @returns Milliseconds to wait before retrying.
 */
export function jitterBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const upperBoundMs = Math.min(2 ** attempt * baseDelayMs, maxDelayMs);
  return Math.floor(Math.random() * upperBoundMs);
}

/**
 * Retry an async function up to `n` total attempts with jittered exponential backoff.
 *
 * @param n Total number of attempts (must be a finite integer >= 1).
 * @param fn The async function to retry. Receives the current attempt number (1-indexed).
 * @param options Retry configuration.
 * @returns The result of `fn` on success.
 * @throws The last error if all attempts fail or `shouldRetry` returns false.
 */
export async function tryN<T>(
  n: number,
  fn: (attempt: number) => Promise<T>,
  options?: TryNOptions
): Promise<T> {
  if (!Number.isFinite(n) || n < 1) {
    throw new Error("retry.maxAttempts must be >= 1");
  }
  n = Math.floor(n);

  const rawBase = options?.baseDelayMs ?? 100;
  const rawMax = options?.maxDelayMs ?? 3000;

  if (!Number.isFinite(rawBase) || rawBase <= 0) {
    throw new Error("retry.baseDelayMs must be > 0");
  }
  if (!Number.isFinite(rawMax) || rawMax <= 0) {
    throw new Error("retry.maxDelayMs must be > 0");
  }

  const baseDelayMs = Math.floor(rawBase);
  const maxDelayMs = Math.floor(rawMax);

  if (baseDelayMs > maxDelayMs) {
    throw new Error("retry.baseDelayMs must be <= retry.maxDelayMs");
  }

  let attempt = 1;
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      const nextAttempt = attempt + 1;
      if (
        nextAttempt > n ||
        (options?.shouldRetry && !options.shouldRetry(err, nextAttempt))
      ) {
        throw err;
      }
      const delay = jitterBackoff(attempt, baseDelayMs, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt = nextAttempt;
    }
  }
}

/**
 * Returns true if the given error is retryable according to Durable Object error handling.
 * See https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
 *
 * An error is retryable if it has `retryable: true` but is NOT an overloaded error.
 */
export function isErrorRetryable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const msg = String(err);
  const typed = err as { retryable?: boolean; overloaded?: boolean };
  return (
    Boolean(typed.retryable) &&
    !typed.overloaded &&
    !msg.includes("Durable Object is overloaded")
  );
}
