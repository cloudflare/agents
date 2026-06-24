import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RETRY_MAX_ATTEMPTS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  defaultRetryDelayMs,
  resolveRetryPolicy,
  type CodemodeRetryContext,
  type ExecuteFailure
} from "../retry";

function context(failure: ExecuteFailure, attempt = 1): CodemodeRetryContext {
  return {
    executionId: "exec_1",
    attempt,
    failure,
    execution: {
      id: "exec_1",
      code: "async () => {}",
      status: "running",
      log: [],
      createdAt: 1,
      updatedAt: 1
    }
  };
}

describe("retry policy", () => {
  it("uses the default attempt limit and retries only explicit transient failures", async () => {
    const policy = resolveRetryPolicy(undefined);

    expect(policy.maxAttempts).toBe(DEFAULT_RETRY_MAX_ATTEMPTS);
    await expect(
      Promise.resolve(
        policy.shouldRetry(context({ kind: "retryable", message: "busy" }))
      )
    ).resolves.toBe(true);
    await expect(
      Promise.resolve(
        policy.shouldRetry(context({ kind: "timeout", message: "timed out" }))
      )
    ).resolves.toBe(false);
    await expect(
      Promise.resolve(
        policy.shouldRetry(context({ kind: "error", message: "broken" }))
      )
    ).resolves.toBe(false);
  });

  it.each([
    [0, 1],
    [-3, 1],
    [2.9, 2],
    [Number.POSITIVE_INFINITY, 1],
    [Number.NaN, 1]
  ])("normalizes maxAttempts %s to %s", (configured, expected) => {
    expect(resolveRetryPolicy({ maxAttempts: configured }).maxAttempts).toBe(
      expected
    );
  });

  it("disables retries explicitly", async () => {
    const policy = resolveRetryPolicy(false);

    expect(policy.maxAttempts).toBe(1);
    await expect(
      Promise.resolve(
        policy.shouldRetry(context({ kind: "retryable", message: "busy" }))
      )
    ).resolves.toBe(false);
    await expect(
      Promise.resolve(
        policy.delayMs(context({ kind: "retryable", message: "busy" }))
      )
    ).resolves.toBe(0);
  });

  it("uses custom retry and delay callbacks", async () => {
    const shouldRetry = vi.fn(() => true);
    const delayMs = vi.fn(() => 123);
    const policy = resolveRetryPolicy({ shouldRetry, delayMs });
    const ctx = context({ kind: "timeout", message: "timed out" });

    await expect(Promise.resolve(policy.shouldRetry(ctx))).resolves.toBe(true);
    await expect(Promise.resolve(policy.delayMs(ctx))).resolves.toBe(123);
    expect(shouldRetry).toHaveBeenCalledWith(ctx);
    expect(delayMs).toHaveBeenCalledWith(ctx);
  });
});

describe("defaultRetryDelayMs", () => {
  it("honors and clamps server-provided retry delays", () => {
    expect(
      defaultRetryDelayMs(
        context({ kind: "retryable", message: "busy", retryAfterMs: 250 })
      )
    ).toBe(250);
    expect(
      defaultRetryDelayMs(
        context({ kind: "retryable", message: "busy", retryAfterMs: -1 })
      )
    ).toBe(0);
  });

  it("uses bounded exponential backoff", () => {
    const failure = { kind: "retryable", message: "busy" } as const;

    expect(defaultRetryDelayMs(context(failure, 1))).toBe(500);
    expect(defaultRetryDelayMs(context(failure, 2))).toBe(1_000);
    expect(defaultRetryDelayMs(context(failure, 20))).toBe(
      DEFAULT_RETRY_MAX_DELAY_MS
    );
  });
});
