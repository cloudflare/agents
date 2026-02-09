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
 * Internal options for tryN -- extends RetryOptions with an isRetryable predicate.
 */
interface TryNOptions extends RetryOptions {
  /**
   * Predicate to determine if an error is retryable.
   * If not provided, all errors are retried.
   */
  isRetryable?: (err: unknown, nextAttempt: number) => boolean;
}

/**
 * Validate retry options eagerly so invalid config fails at enqueue/schedule time
 * rather than at execution time. Checks individual field ranges and cross-field
 * constraints when both baseDelayMs and maxDelayMs are provided.
 */
export function validateRetryOptions(options: RetryOptions): void {
  if (options.maxAttempts !== undefined) {
    if (!Number.isFinite(options.maxAttempts) || options.maxAttempts < 1) {
      throw new Error("retry.maxAttempts must be >= 1");
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
  if (options.baseDelayMs !== undefined && options.maxDelayMs !== undefined) {
    if (options.baseDelayMs > options.maxDelayMs) {
      throw new Error("retry.baseDelayMs must be <= retry.maxDelayMs");
    }
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
 * @param n Total number of attempts (must be >= 1).
 * @param fn The async function to retry. Receives the current attempt number (1-indexed).
 * @param options Retry configuration.
 * @returns The result of `fn` on success.
 * @throws The last error if all attempts fail or `isRetryable` returns false.
 */
export async function tryN<T>(
  n: number,
  fn: (attempt: number) => Promise<T>,
  options?: TryNOptions
): Promise<T> {
  if (n <= 0) {
    throw new Error("n must be greater than 0");
  }
  n = Math.floor(n);

  const baseDelayMs = Math.floor(options?.baseDelayMs ?? 100);
  const maxDelayMs = Math.floor(options?.maxDelayMs ?? 3000);

  if (baseDelayMs <= 0 || maxDelayMs <= 0) {
    throw new Error("baseDelayMs and maxDelayMs must be greater than 0");
  }
  if (baseDelayMs > maxDelayMs) {
    throw new Error("baseDelayMs must be less than or equal to maxDelayMs");
  }

  let attempt = 1;
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      const nextAttempt = attempt + 1;
      if (
        nextAttempt > n ||
        (options?.isRetryable && !options.isRetryable(err, nextAttempt))
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
