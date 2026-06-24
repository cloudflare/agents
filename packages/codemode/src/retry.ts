import type { ExecutionState } from "./runtime";

/** Machine-readable reason an executor pass failed. */
export type ExecuteFailure = {
  /** Ordinary sandbox failure, an explicitly retryable connector failure, or a timeout. */
  kind: "error" | "retryable" | "timeout";
  message: string;
  /** Optional server-provided delay, for example from Retry-After. */
  retryAfterMs?: number;
};

export type CodemodeRetryContext = {
  executionId: string;
  /** One-based attempt number that just failed. */
  attempt: number;
  failure: ExecuteFailure;
  /** Durable execution snapshot at the failure boundary. */
  execution: ExecutionState;
};

export const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
export const DEFAULT_RETRY_MAX_DELAY_MS = 10_000;

export type CodemodeRetryOptions = {
  /** Total execution attempts, including the initial attempt. Defaults to 3. */
  maxAttempts?: number;
  /**
   * Decide whether a failed pass is safe to retry. By default only failures
   * raised with RetryableError are retried; timeouts require an explicit policy
   * because a timed-out mutation may have succeeded remotely.
   */
  shouldRetry?: (context: CodemodeRetryContext) => boolean | Promise<boolean>;
  /**
   * Delay before the next pass. Defaults to failure.retryAfterMs, then bounded
   * exponential backoff (500ms, 1s, up to 10s). The failed pass is fenced
   * before this delay starts.
   */
  delayMs?: (context: CodemodeRetryContext) => number | Promise<number>;
};

/** Pass `false` to disable the default RetryableError policy. */
export type CodemodeRetryPolicy = CodemodeRetryOptions | false;

export type ResolvedRetryPolicy = {
  maxAttempts: number;
  shouldRetry: (context: CodemodeRetryContext) => boolean | Promise<boolean>;
  delayMs: (context: CodemodeRetryContext) => number | Promise<number>;
};

export function resolveRetryPolicy(
  policy: CodemodeRetryPolicy | undefined
): ResolvedRetryPolicy {
  if (policy === false) {
    return {
      maxAttempts: 1,
      shouldRetry: () => false,
      delayMs: () => 0
    };
  }

  const configuredAttempts = policy?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
  return {
    maxAttempts: Number.isFinite(configuredAttempts)
      ? Math.max(1, Math.floor(configuredAttempts))
      : 1,
    shouldRetry:
      policy?.shouldRetry ?? (({ failure }) => failure.kind === "retryable"),
    delayMs: policy?.delayMs ?? defaultRetryDelayMs
  };
}

export function defaultRetryDelayMs(context: CodemodeRetryContext): number {
  if (context.failure.retryAfterMs !== undefined) {
    return Math.max(0, context.failure.retryAfterMs);
  }
  return Math.min(
    DEFAULT_RETRY_BASE_DELAY_MS * 2 ** (context.attempt - 1),
    DEFAULT_RETRY_MAX_DELAY_MS
  );
}

/**
 * Throw from a connector to request retry of the current durable execution.
 * The signal crosses the connector RPC and sandbox boundaries as structured
 * metadata; callers never need to match an error message.
 */
export class RetryableError extends Error {
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options?: { retryAfterMs?: number; cause?: unknown }
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "RetryableError";
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export function isRetryableError(error: unknown): error is RetryableError {
  return error instanceof RetryableError;
}

/** Error thrown by runCode while retaining the executor's structured failure. */
export class CodemodeExecutionError extends Error {
  readonly failure: ExecuteFailure;
  readonly logs?: string[];

  constructor(failure: ExecuteFailure, logs?: string[]) {
    const logContext = logs?.length
      ? `\n\nConsole output:\n${logs.join("\n")}`
      : "";
    super(`Code execution failed: ${failure.message}${logContext}`);
    this.name = "CodemodeExecutionError";
    this.failure = failure;
    this.logs = logs;
  }
}
