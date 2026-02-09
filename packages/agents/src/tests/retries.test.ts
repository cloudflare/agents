import { describe, expect, it } from "vitest";
import {
  isErrorRetryable,
  jitterBackoff,
  tryN,
  validateRetryOptions
} from "../retries";

describe("retries", () => {
  describe("jitterBackoff", () => {
    it("returns values within [0, maxDelayMs] range", () => {
      const baseDelayMs = 100;
      const maxDelayMs = 3000;
      const iterations = 10000;

      const delays = new Set<number>();
      for (let i = 0; i < iterations; i++) {
        const delay = jitterBackoff(i, baseDelayMs, maxDelayMs);
        delays.add(delay);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(maxDelayMs);
      }
      // Should have a good spread of unique delays
      expect(delays.size).toBeGreaterThan(maxDelayMs * 0.5);
    });

    it("increases upper bound with attempt number", () => {
      // Early attempts should have lower upper bound
      const earlyDelays: number[] = [];
      const lateDelays: number[] = [];
      for (let i = 0; i < 1000; i++) {
        earlyDelays.push(jitterBackoff(1, 100, 10000));
        lateDelays.push(jitterBackoff(5, 100, 10000));
      }
      const earlyMax = Math.max(...earlyDelays);
      const lateMax = Math.max(...lateDelays);
      // Late attempts should generally reach higher values
      expect(lateMax).toBeGreaterThan(earlyMax);
    });
  });

  describe("tryN", () => {
    it("succeeds on first attempt", async () => {
      let attempts = 0;
      const result = await tryN(3, async () => {
        attempts++;
        return "ok";
      });
      expect(result).toBe("ok");
      expect(attempts).toBe(1);
    });

    it("succeeds after transient failures", async () => {
      let attempts = 0;
      const result = await tryN(
        10,
        async () => {
          attempts++;
          if (attempts < 4) {
            throw new Error("transient");
          }
          return "ok";
        },
        { baseDelayMs: 1, maxDelayMs: 10 }
      );
      expect(result).toBe("ok");
      expect(attempts).toBe(4);
    });

    it("gives up after n attempts and throws the last error", async () => {
      let attempts = 0;
      await expect(
        tryN(
          3,
          async () => {
            attempts++;
            throw new Error(`fail-${attempts}`);
          },
          { baseDelayMs: 1, maxDelayMs: 10 }
        )
      ).rejects.toThrow("fail-3");
      expect(attempts).toBe(3);
    });

    it("respects isRetryable to bail early", async () => {
      let attempts = 0;
      await expect(
        tryN(
          10,
          async () => {
            attempts++;
            throw new Error(attempts === 1 ? "retryable" : "fatal");
          },
          {
            baseDelayMs: 1,
            maxDelayMs: 10,
            isRetryable: (err) => (err as Error).message === "retryable"
          }
        )
      ).rejects.toThrow("fatal");
      expect(attempts).toBe(2);
    });

    it("passes attempt number to fn", async () => {
      const receivedAttempts: number[] = [];
      await tryN(
        3,
        async (attempt) => {
          receivedAttempts.push(attempt);
          if (attempt < 3) {
            throw new Error("retry");
          }
          return "ok";
        },
        { baseDelayMs: 1, maxDelayMs: 10 }
      );
      expect(receivedAttempts).toEqual([1, 2, 3]);
    });

    it("rejects invalid inputs", async () => {
      const doer = async () => 1;
      await expect(tryN(0, doer)).rejects.toThrow("n must be greater than 0");
      await expect(tryN(1, doer, { baseDelayMs: 0 })).rejects.toThrow(
        "baseDelayMs and maxDelayMs must be greater than 0"
      );
      await expect(tryN(1, doer, { maxDelayMs: 0 })).rejects.toThrow(
        "baseDelayMs and maxDelayMs must be greater than 0"
      );
      await expect(
        tryN(1, doer, { baseDelayMs: 5000, maxDelayMs: 100 })
      ).rejects.toThrow("baseDelayMs must be less than or equal to maxDelayMs");
    });

    it("allows baseDelayMs equal to maxDelayMs", async () => {
      let attempts = 0;
      const result = await tryN(
        3,
        async () => {
          attempts++;
          if (attempts < 3) throw new Error("retry");
          return "ok";
        },
        { baseDelayMs: 100, maxDelayMs: 100 }
      );
      expect(result).toBe("ok");
      expect(attempts).toBe(3);
    });

    it("works with n=1 (no retries)", async () => {
      let attempts = 0;
      // n=1 means exactly one attempt, no retries
      // Need valid baseDelayMs < maxDelayMs even though delay is never used
      await expect(
        tryN(1, async () => {
          attempts++;
          throw new Error("only-once");
        })
      ).rejects.toThrow("only-once");
      expect(attempts).toBe(1);
    });
  });

  describe("validateRetryOptions", () => {
    it("accepts valid options", () => {
      expect(() => validateRetryOptions({})).not.toThrow();
      expect(() => validateRetryOptions({ maxAttempts: 5 })).not.toThrow();
      expect(() =>
        validateRetryOptions({ baseDelayMs: 100, maxDelayMs: 3000 })
      ).not.toThrow();
      expect(() =>
        validateRetryOptions({
          maxAttempts: 1,
          baseDelayMs: 500,
          maxDelayMs: 500
        })
      ).not.toThrow();
    });

    it("rejects maxAttempts < 1", () => {
      expect(() => validateRetryOptions({ maxAttempts: 0 })).toThrow(
        "retry.maxAttempts must be >= 1"
      );
      expect(() => validateRetryOptions({ maxAttempts: -1 })).toThrow(
        "retry.maxAttempts must be >= 1"
      );
    });

    it("rejects non-finite maxAttempts", () => {
      expect(() => validateRetryOptions({ maxAttempts: Number.NaN })).toThrow(
        "retry.maxAttempts must be >= 1"
      );
      expect(() =>
        validateRetryOptions({ maxAttempts: Number.POSITIVE_INFINITY })
      ).toThrow("retry.maxAttempts must be >= 1");
    });

    it("rejects baseDelayMs <= 0", () => {
      expect(() => validateRetryOptions({ baseDelayMs: 0 })).toThrow(
        "retry.baseDelayMs must be > 0"
      );
      expect(() => validateRetryOptions({ baseDelayMs: -100 })).toThrow(
        "retry.baseDelayMs must be > 0"
      );
    });

    it("rejects maxDelayMs <= 0", () => {
      expect(() => validateRetryOptions({ maxDelayMs: 0 })).toThrow(
        "retry.maxDelayMs must be > 0"
      );
    });

    it("rejects baseDelayMs > maxDelayMs", () => {
      expect(() =>
        validateRetryOptions({ baseDelayMs: 5000, maxDelayMs: 100 })
      ).toThrow("retry.baseDelayMs must be <= retry.maxDelayMs");
    });

    it("allows baseDelayMs equal to maxDelayMs", () => {
      expect(() =>
        validateRetryOptions({ baseDelayMs: 1000, maxDelayMs: 1000 })
      ).not.toThrow();
    });

    it("skips cross-field check when only one delay field is provided", () => {
      // baseDelayMs: 5000 alone is valid — the default maxDelayMs (3000)
      // would cause a failure at execution time, but validateRetryOptions
      // only checks fields that are explicitly provided.
      expect(() => validateRetryOptions({ baseDelayMs: 5000 })).not.toThrow();
      expect(() => validateRetryOptions({ maxDelayMs: 50 })).not.toThrow();
    });
  });

  describe("isErrorRetryable", () => {
    function retryableError(msg: string) {
      const e = new Error(msg);
      (e as unknown as { retryable: boolean }).retryable = true;
      return e;
    }

    it("returns true for retryable, non-overloaded errors", () => {
      expect(isErrorRetryable(retryableError("transient"))).toBe(true);
      expect(isErrorRetryable(retryableError("Network connection lost."))).toBe(
        true
      );
    });

    it("returns false for non-retryable errors", () => {
      expect(isErrorRetryable(new Error("Network connection lost."))).toBe(
        false
      );
    });

    const overloadedMessages = [
      "Durable Object is overloaded. Too many requests queued.",
      "Durable Object is overloaded. Requests queued for too long.",
      "Durable Object is overloaded. Too many requests for the same object within a 10 second window."
    ];

    it.each(overloadedMessages)(
      "returns false for overloaded error: %s",
      (msg) => {
        expect(isErrorRetryable(retryableError(msg))).toBe(false);
      }
    );

    it("returns false for overloaded property", () => {
      const e = retryableError("some error");
      (e as unknown as { overloaded: boolean }).overloaded = true;
      expect(isErrorRetryable(e)).toBe(false);
    });

    it("returns false for non-object errors", () => {
      expect(isErrorRetryable(null)).toBe(false);
      expect(isErrorRetryable(undefined)).toBe(false);
      expect(isErrorRetryable("string error")).toBe(false);
      expect(isErrorRetryable(42)).toBe(false);
    });
  });
});
