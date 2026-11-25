import { describe, expect, it } from "vitest";
import {
  computeRetryDelayMs,
  type ResolvedStepPolicy
} from "../../tasks/replay";

const DAY_MS = 24 * 60 * 60 * 1000;

const exponential: ResolvedStepPolicy = {
  retryLimit: 50,
  retryDelayMs: 60 * 60 * 1000,
  backoff: "exponential",
  timeoutMs: 30_000
};

describe("computeRetryDelayMs", () => {
  it("keeps exponential retries jittered at the one-day cap", () => {
    const delays = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      // 1 h doubled nine times is far past a day.
      const delay = computeRetryDelayMs(exponential, 10);
      expect(delay).toBeGreaterThanOrEqual(DAY_MS / 2);
      expect(delay).toBeLessThan(DAY_MS);
      delays.add(delay);
    }
    expect(delays.size).toBeGreaterThan(900);
  });

  it("keeps constant and linear delays exact, capped at a day", () => {
    expect(
      computeRetryDelayMs({ ...exponential, backoff: "constant" }, 7)
    ).toBe(60 * 60 * 1000);
    expect(computeRetryDelayMs({ ...exponential, backoff: "linear" }, 3)).toBe(
      3 * 60 * 60 * 1000
    );
    expect(computeRetryDelayMs({ ...exponential, backoff: "linear" }, 40)).toBe(
      DAY_MS
    );
  });
});
