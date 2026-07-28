/** Whether a failed dispatch may be retried or must stop permanently. */
export type DispatchErrorClass = "retryable" | "permanent";

/** Decides whether an error thrown while dispatching may be retried. */
export type DispatchErrorClassifier = (error: unknown) => DispatchErrorClass;

/**
 * An error that must not be retried: malformed input, an authentication or
 * authorization failure, or an explicit permanent rejection by the agent.
 *
 * Receivers and transports throw this (or any error carrying
 * `retryable: false`) to stop automatic delivery immediately.
 */
export class PermanentDispatchError extends Error {
  readonly retryable = false;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentDispatchError";
  }
}

/**
 * Default classification: an error is permanent only when it says so.
 *
 * Anything else — network failures, timeouts surfaced as errors, and unnamed
 * server errors — is treated as retryable, because retrying a transient
 * failure is recoverable while abandoning one is not. At-least-once delivery
 * makes an over-eager retry safe; agents deduplicate using the stable turn ID.
 */
export const classifyDispatchError: DispatchErrorClassifier = (error) => {
  if (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    (error as { retryable: unknown }).retryable === false
  ) {
    return "permanent";
  }
  return "retryable";
};
