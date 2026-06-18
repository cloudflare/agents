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

/**
 * The "superseded isolate" platform messages — the invocation is running on an
 * isolate the platform has replaced with a new version (a deploy / code
 * update). For the rest of that invocation every operation throws the same
 * error (code never reloads mid-invocation), so in-process retries are futile;
 * but the next fresh invocation runs the new code and succeeds.
 *
 * workerd surfaces this as a plain `Error` with one of a few messages, all the
 * same failure class — a message match is the only signal:
 *   - "Durable Object reset because its code was updated."  (DO storage op on a
 *     superseded isolate / deploy bounce)
 *   - "This script has been upgraded. Please send a new request to connect to
 *     the new version."  (a stub/connection to a superseded script; the message
 *     literally instructs the caller to retry on the new version)
 *
 * The match stays close to the verbatim platform strings (rather than a loose
 * "upgraded"/"reset" substring) so an ordinary application error that happens
 * to mention those words is NOT misclassified as a supersede.
 */
const SUPERSEDED_ISOLATE_PATTERN =
  /reset because its code was updated|this script has been upgraded/i;

/**
 * The "Network connection lost." platform transient — the connection between
 * the isolate and its storage (or another DO) dropped. Unlike a supersede this
 * MAY succeed on an in-process retry (a momentary blip), so it must not skip
 * the in-process retry budget — but during a deploy-reset window it never
 * succeeds in-process and surfaces interleaved with the supersede messages
 * (SQL ops throw `SqlError: SQL query failed: Network connection lost.` while
 * KV ops throw the reset message), so on retry exhaustion it must be treated
 * as the platform's failure, not the callback's.
 */
const CONNECTION_LOST_PATTERN = /network connection lost/i;

function errorMessageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
}

/**
 * Iterate an error and its `cause` chain (depth-limited so a cyclic chain
 * can't spin). Wrappers like `SqlError` carry the original platform error in
 * `cause` and may not propagate signal properties (e.g. the CF `retryable`
 * flag), so classification must look through them.
 */
function* selfAndCauses(error: unknown): Generator<unknown> {
  let current = error;
  for (let depth = 0; depth < 8 && current != null; depth++) {
    yield current;
    current =
      typeof current === "object"
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
}

/**
 * Whether an error (or anything in its `cause` chain) is a transient
 * "superseded isolate" failure — see `SUPERSEDED_ISOLATE_PATTERN`. In-process
 * retries are futile for this class; the work must be deferred to a fresh
 * invocation, which runs the new code and succeeds.
 */
export function isDurableObjectCodeUpdateReset(error: unknown): boolean {
  for (const e of selfAndCauses(error)) {
    if (SUPERSEDED_ISOLATE_PATTERN.test(errorMessageOf(e))) return true;
  }
  return false;
}

/**
 * Whether an error (or anything in its `cause` chain) is a transient failure
 * of the PLATFORM rather than of the code that threw it:
 *
 *   - a superseded-isolate reset ("reset because its code was updated" /
 *     "this script has been upgraded") — a deploy replaced the isolate;
 *   - an error the platform itself flags `retryable: true` (excluding
 *     overloaded errors, where retrying the same object won't help) — see
 *     `isErrorRetryable`;
 *   - "Network connection lost." — the storage/stub connection dropped. The
 *     CF `retryable` flag does not survive error wrappers (e.g. `SqlError`
 *     copies only the message + `cause`) and is absent in some local-dev
 *     shapes, so the verbatim message is matched as well.
 *
 * Used to decide whether failed work should be RE-RUN LATER (platform
 * transient — the same work succeeds once the platform recovers, typically
 * seconds after a deploy) versus ABANDONED as genuinely failing (application
 * error — re-running yields the same failure). A genuine application error
 * carries none of these signals, so it is never misclassified by this check.
 */
export function isPlatformTransientError(error: unknown): boolean {
  for (const e of selfAndCauses(error)) {
    const message = errorMessageOf(e);
    if (SUPERSEDED_ISOLATE_PATTERN.test(message)) return true;
    if (CONNECTION_LOST_PATTERN.test(message)) return true;
    if (isErrorRetryable(e)) return true;
  }
  return false;
}
