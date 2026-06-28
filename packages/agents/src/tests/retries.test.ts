import { describe, expect, it } from "vitest";
import {
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
  isErrorRetryable,
  isPlatformTransientError,
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

    it("respects shouldRetry to bail early", async () => {
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
            shouldRetry: (err) => (err as Error).message === "retryable"
          }
        )
      ).rejects.toThrow("fatal");
      expect(attempts).toBe(2);
    });

    it("passes nextAttempt to shouldRetry", async () => {
      const receivedNextAttempts: number[] = [];
      await expect(
        tryN(
          5,
          async () => {
            throw new Error("fail");
          },
          {
            baseDelayMs: 1,
            maxDelayMs: 10,
            shouldRetry: (_err, nextAttempt) => {
              receivedNextAttempts.push(nextAttempt);
              return true;
            }
          }
        )
      ).rejects.toThrow("fail");
      // shouldRetry is called for attempts 1→2, 2→3, 3→4, 4→5
      expect(receivedNextAttempts).toEqual([2, 3, 4, 5]);
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
      await expect(tryN(0, doer)).rejects.toThrow(
        "retry.maxAttempts must be >= 1"
      );
      await expect(tryN(1, doer, { baseDelayMs: 0 })).rejects.toThrow(
        "retry.baseDelayMs must be > 0"
      );
      await expect(tryN(1, doer, { maxDelayMs: 0 })).rejects.toThrow(
        "retry.maxDelayMs must be > 0"
      );
      await expect(
        tryN(1, doer, { baseDelayMs: 5000, maxDelayMs: 100 })
      ).rejects.toThrow("retry.baseDelayMs must be <= retry.maxDelayMs");
    });

    it("rejects NaN and Infinity", async () => {
      const doer = async () => 1;
      await expect(tryN(Number.NaN, doer)).rejects.toThrow(
        "retry.maxAttempts must be >= 1"
      );
      await expect(tryN(Number.POSITIVE_INFINITY, doer)).rejects.toThrow(
        "retry.maxAttempts must be >= 1"
      );
      await expect(tryN(1, doer, { baseDelayMs: Number.NaN })).rejects.toThrow(
        "retry.baseDelayMs must be > 0"
      );
      await expect(tryN(1, doer, { maxDelayMs: Number.NaN })).rejects.toThrow(
        "retry.maxDelayMs must be > 0"
      );
      await expect(
        tryN(1, doer, { baseDelayMs: Number.POSITIVE_INFINITY })
      ).rejects.toThrow("retry.baseDelayMs must be > 0");
    });

    it("floors fractional n to integer", async () => {
      let attempts = 0;
      await expect(
        tryN(
          2.9,
          async () => {
            attempts++;
            throw new Error(`fail-${attempts}`);
          },
          { baseDelayMs: 1, maxDelayMs: 10 }
        )
      ).rejects.toThrow("fail-2");
      // 2.9 floors to 2, so exactly 2 attempts
      expect(attempts).toBe(2);
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

    it("rejects non-integer maxAttempts", () => {
      expect(() => validateRetryOptions({ maxAttempts: 2.5 })).toThrow(
        "retry.maxAttempts must be an integer"
      );
      expect(() => validateRetryOptions({ maxAttempts: 3.1 })).toThrow(
        "retry.maxAttempts must be an integer"
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

    it("skips cross-field check when no defaults and only one delay field", () => {
      // Without defaults, we can't validate cross-field constraints
      // when only one field is provided.
      expect(() => validateRetryOptions({ baseDelayMs: 5000 })).not.toThrow();
      expect(() => validateRetryOptions({ maxDelayMs: 50 })).not.toThrow();
    });

    describe("with defaults", () => {
      const defaults = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 3000 };

      it("rejects baseDelayMs exceeding default maxDelayMs", () => {
        expect(() =>
          validateRetryOptions({ baseDelayMs: 5000 }, defaults)
        ).toThrow("retry.baseDelayMs must be <= retry.maxDelayMs");
      });

      it("rejects default baseDelayMs exceeding explicit maxDelayMs", () => {
        expect(() =>
          validateRetryOptions({ maxDelayMs: 50 }, defaults)
        ).toThrow("retry.baseDelayMs must be <= retry.maxDelayMs");
      });

      it("accepts valid options resolved against defaults", () => {
        expect(() =>
          validateRetryOptions({ baseDelayMs: 200 }, defaults)
        ).not.toThrow();
        expect(() =>
          validateRetryOptions({ maxDelayMs: 5000 }, defaults)
        ).not.toThrow();
        expect(() =>
          validateRetryOptions({ maxAttempts: 5 }, defaults)
        ).not.toThrow();
      });
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

  describe("isDurableObjectCodeUpdateReset", () => {
    it("matches the verbatim supersede messages", () => {
      expect(
        isDurableObjectCodeUpdateReset(
          new Error("Durable Object reset because its code was updated.")
        )
      ).toBe(true);
      expect(
        isDurableObjectCodeUpdateReset(
          new Error(
            "This script has been upgraded. Please send a new request to connect to the new version."
          )
        )
      ).toBe(true);
    });

    it("looks through wrapper errors via the cause chain (SqlError shape)", () => {
      // `SqlError` includes the cause message in its own message, but other
      // wrappers may not — the cause chain is the robust signal.
      const wrapped = new Error("query aborted", {
        cause: new Error("Durable Object reset because its code was updated.")
      });
      expect(isDurableObjectCodeUpdateReset(wrapped)).toBe(true);
    });

    it("does not match lookalike application errors", () => {
      expect(
        isDurableObjectCodeUpdateReset(
          new Error("Your subscription script has been upgraded to a new plan.")
        )
      ).toBe(false);
      expect(
        isDurableObjectCodeUpdateReset(new Error("Network connection lost."))
      ).toBe(false);
      expect(isDurableObjectCodeUpdateReset(null)).toBe(false);
      expect(isDurableObjectCodeUpdateReset(undefined)).toBe(false);
    });

    it("terminates on a cyclic cause chain", () => {
      const e = new Error("app error");
      (e as unknown as { cause: unknown }).cause = e;
      expect(isDurableObjectCodeUpdateReset(e)).toBe(false);
    });
  });

  describe("isDurableObjectMemoryLimitReset", () => {
    it("matches the DO and D1 memory-limit reset messages", () => {
      expect(
        isDurableObjectMemoryLimitReset(
          new Error(
            "Durable Object's isolate exceeded its memory limit and was reset."
          )
        )
      ).toBe(true);
      expect(
        isDurableObjectMemoryLimitReset(
          new Error("D1 DB's isolate exceeded its memory limit and was reset.")
        )
      ).toBe(true);
    });

    it("matches a truncated/reworded surfacing missing the '...and was reset' tail", () => {
      // Real-world logs (#1825) clipped the message to just the core fragment;
      // the broadened predicate must still classify it so the circuit breaker
      // can engage.
      expect(
        isDurableObjectMemoryLimitReset(
          new Error("Durable Object's isolate exceeded its memory limit")
        )
      ).toBe(true);
      expect(
        isDurableObjectMemoryLimitReset(
          "Error: the isolate exceeded its memory limit (128 MB)"
        )
      ).toBe(true);
    });

    it("looks through wrapper errors via the cause chain (SqlError shape)", () => {
      const wrapped = new Error("SQL query failed", {
        cause: new Error(
          "Durable Object's isolate exceeded its memory limit and was reset."
        )
      });
      expect(isDurableObjectMemoryLimitReset(wrapped)).toBe(true);
    });

    it("matches a raw error-message string (returned-result path)", () => {
      expect(
        isDurableObjectMemoryLimitReset(
          "Durable Object's isolate exceeded its memory limit and was reset."
        )
      ).toBe(true);
    });

    it("is NOT classified as a platform transient (must not be deferred)", () => {
      // The whole point of #1825: a memory reset re-OOMs on re-run, so it must
      // NOT join the defer-and-retry-forever transient class.
      const oom = new Error(
        "Durable Object's isolate exceeded its memory limit and was reset."
      );
      expect(isDurableObjectMemoryLimitReset(oom)).toBe(true);
      expect(isPlatformTransientError(oom)).toBe(false);
      expect(isDurableObjectCodeUpdateReset(oom)).toBe(false);
    });

    it("does not match lookalike application errors or empty inputs", () => {
      expect(
        isDurableObjectMemoryLimitReset(
          new Error("Your plan exceeded its memory quota.")
        )
      ).toBe(false);
      expect(isDurableObjectMemoryLimitReset(new Error("boom"))).toBe(false);
      expect(isDurableObjectMemoryLimitReset(null)).toBe(false);
      expect(isDurableObjectMemoryLimitReset(undefined)).toBe(false);
    });

    it("terminates on a cyclic cause chain", () => {
      const e = new Error("app error");
      (e as unknown as { cause: unknown }).cause = e;
      expect(isDurableObjectMemoryLimitReset(e)).toBe(false);
    });
  });

  describe("isPlatformTransientError", () => {
    function retryableError(msg: string) {
      const e = new Error(msg);
      (e as unknown as { retryable: boolean }).retryable = true;
      return e;
    }

    it("classifies supersede messages as transient", () => {
      expect(
        isPlatformTransientError(
          new Error("Durable Object reset because its code was updated.")
        )
      ).toBe(true);
      expect(
        isPlatformTransientError(
          new Error(
            "This script has been upgraded. Please send a new request to connect to the new version."
          )
        )
      ).toBe(true);
    });

    it('classifies "Network connection lost." as transient (bare and SqlError-wrapped)', () => {
      // The deploy-reset window surfaces SQL failures as
      // `SqlError: SQL query failed: Network connection lost.` — the wrapper
      // drops the CF `retryable` flag, so the message itself must classify
      // (#1730).
      expect(
        isPlatformTransientError(new Error("Network connection lost."))
      ).toBe(true);
      expect(
        isPlatformTransientError(
          new Error("SQL query failed: Network connection lost.")
        )
      ).toBe(true);
    });

    it("classifies a retryable-flagged platform error as transient", () => {
      expect(isPlatformTransientError(retryableError("internal error"))).toBe(
        true
      );
    });

    it("excludes overloaded errors (retrying the same object won't help)", () => {
      expect(
        isPlatformTransientError(
          retryableError(
            "Durable Object is overloaded. Too many requests queued."
          )
        )
      ).toBe(false);
      const e = retryableError("some error");
      (e as unknown as { overloaded: boolean }).overloaded = true;
      expect(isPlatformTransientError(e)).toBe(false);
    });

    it("looks through wrapper errors via the cause chain", () => {
      // A wrapper whose own message carries no signal but whose cause is a
      // retryable platform error (the flag does not survive the wrapper).
      const wrapped = new Error("operation failed", {
        cause: retryableError("internal error")
      });
      expect(isPlatformTransientError(wrapped)).toBe(true);

      const deeplyWrapped = new Error("outer", {
        cause: new Error("middle", {
          cause: new Error("Network connection lost.")
        })
      });
      expect(isPlatformTransientError(deeplyWrapped)).toBe(true);
    });

    it("does NOT classify application errors as transient", () => {
      expect(isPlatformTransientError(new Error("boom"))).toBe(false);
      expect(
        isPlatformTransientError(
          new Error("Your subscription script has been upgraded to a new plan.")
        )
      ).toBe(false);
      expect(
        isPlatformTransientError(
          new Error("app failure", { cause: new Error("inner app failure") })
        )
      ).toBe(false);
      expect(isPlatformTransientError(null)).toBe(false);
      expect(isPlatformTransientError(undefined)).toBe(false);
      expect(isPlatformTransientError(42)).toBe(false);
    });

    it("accepts bare string errors", () => {
      expect(isPlatformTransientError("Network connection lost.")).toBe(true);
      expect(isPlatformTransientError("some app error")).toBe(false);
    });

    it("terminates on a cyclic cause chain", () => {
      const e = new Error("app error");
      (e as unknown as { cause: unknown }).cause = e;
      expect(isPlatformTransientError(e)).toBe(false);
    });
  });
});
