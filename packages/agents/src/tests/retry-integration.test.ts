import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName } from "..";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("retry integration", () => {
  // ── this.retry() ─────────────────────────────────────────────────

  describe("this.retry()", () => {
    it("succeeds on first attempt without retrying", async () => {
      const stub = await getAgentByName(
        env.TestRetryAgent,
        "retry-first-attempt"
      );
      const { result, attempts } = await stub.retrySucceedsOnAttempt(1);
      expect(result).toBe("ok-1");
      expect(attempts).toEqual([1]);
    });

    it("retries transient failures and succeeds", async () => {
      const stub = await getAgentByName(env.TestRetryAgent, "retry-transient");
      const { result, attempts } = await stub.retrySucceedsOnAttempt(3);
      expect(result).toBe("ok-3");
      expect(attempts).toEqual([1, 2, 3]);
    });

    it("throws last error when retries are exhausted", async () => {
      const stub = await getAgentByName(env.TestRetryAgent, "retry-exhausted");
      const { error } = await stub.retryExhausted();
      expect(error).toBe("always-fail-2");
    });
  });

  // ── shouldRetry ──────────────────────────────────────────────────

  describe("shouldRetry predicate", () => {
    it("retries transient errors and succeeds", async () => {
      const stub = await getAgentByName(
        env.TestRetryAgent,
        "should-retry-transient"
      );
      const { result, attempts, error } = await stub.retryWithShouldRetry(
        2,
        false
      );
      expect(error).toBe("");
      expect(result).toBe("ok-3");
      expect(attempts).toEqual([1, 2, 3]);
    });

    it("bails early on permanent errors", async () => {
      const stub = await getAgentByName(
        env.TestRetryAgent,
        "should-retry-permanent"
      );
      const { error } = await stub.retryWithShouldRetry(1, true);
      expect(error).toBe("permanent-1");
    });

    it("receives the next attempt number", async () => {
      const stub = await getAgentByName(
        env.TestRetryAgent,
        "should-retry-attempt-number"
      );
      const { result, receivedAttempts } =
        await stub.retryWithAttemptAwareShouldRetry();
      expect(result).toBe("ok-4");
      // shouldRetry is called before attempts 2, 3, 4
      expect(receivedAttempts).toEqual([2, 3, 4]);
    });
  });

  // ── queue() with retry ───────────────────────────────────────────

  describe("queue() with retry options", () => {
    it("retries queue callback and succeeds", async () => {
      const stub = await getAgentByName(
        env.TestRetryAgent,
        "queue-retry-succeed"
      );
      await stub.enqueueWithRetry(3, {
        maxAttempts: 5,
        baseDelayMs: 1,
        maxDelayMs: 10
      });

      // Wait for the queue to flush and retries to complete
      const start = Date.now();
      let result = await stub.getQueueCallbackResult();
      while (result.result === null && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 50));
        result = await stub.getQueueCallbackResult();
      }

      expect(result.attempts).toBe(3);
      expect(result.result).toBe("queue-ok-3");
    });

    it("persists retry options on queued items", async () => {
      const stub = await getAgentByName(
        env.TestRetryAgent,
        "queue-retry-persist"
      );
      const retryOpts = {
        maxAttempts: 7,
        baseDelayMs: 200,
        maxDelayMs: 5000
      };
      const persisted = await stub.enqueueAndGetRetryOptions(retryOpts);
      expect(persisted).toEqual(retryOpts);
    });

    it("persists retry options on multiple queued items via getQueues", async () => {
      const stub = await getAgentByName(
        env.TestRetryAgent,
        "queue-retry-get-queues"
      );
      const retryOptions = await stub.enqueueMultipleAndGetRetryOptions();
      expect(retryOptions).toEqual([
        { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
        { maxAttempts: 7, baseDelayMs: 200, maxDelayMs: 5000 }
      ]);
    });
  });

  // ── schedule() with retry ────────────────────────────────────────

  describe("schedule() with retry options", () => {
    it("retries scheduled callback and succeeds", async () => {
      const stub = await getAgentByName(
        env.TestRetryAgent,
        "schedule-retry-succeed"
      );
      await stub.scheduleWithRetry(3, {
        maxAttempts: 5,
        baseDelayMs: 1,
        maxDelayMs: 10
      });

      // Wait for the alarm to fire and retries to complete
      const start = Date.now();
      let result = await stub.getScheduleCallbackResult();
      while (result.result === null && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 50));
        result = await stub.getScheduleCallbackResult();
      }

      expect(result.attempts).toBe(3);
      expect(result.result).toBe("schedule-ok-3");
    });

    it("persists retry options on schedules", async () => {
      const stub = await getAgentByName(
        env.TestRetryAgent,
        "schedule-retry-persist"
      );
      const retryOpts = {
        maxAttempts: 4,
        baseDelayMs: 150,
        maxDelayMs: 2000
      };
      const persisted = await stub.scheduleAndGetRetryOptions(retryOpts);
      expect(persisted).toEqual(retryOpts);
    });
  });

  // ── validation ───────────────────────────────────────────────────

  describe("eager validation", () => {
    it("rejects invalid retry options on queue()", async () => {
      const stub = await getAgentByName(env.TestRetryAgent, "validate-queue");
      const { error } = await stub.enqueueWithInvalidRetry();
      expect(error).toBe("retry.maxAttempts must be >= 1");
    });

    it("rejects invalid retry options on schedule()", async () => {
      const stub = await getAgentByName(
        env.TestRetryAgent,
        "validate-schedule"
      );
      const { error } = await stub.scheduleWithInvalidRetry();
      expect(error).toBe("retry.maxAttempts must be >= 1");
    });

    it("rejects cross-field invalid options resolved against defaults", async () => {
      const stub = await getAgentByName(
        env.TestRetryAgent,
        "validate-cross-field"
      );
      // baseDelayMs: 5000 with default maxDelayMs: 3000 should fail
      const { error } = await stub.enqueueWithCrossFieldInvalidRetry();
      expect(error).toBe("retry.baseDelayMs must be <= retry.maxDelayMs");
    });

    it("rejects fractional maxAttempts on this.retry()", async () => {
      const stub = await getAgentByName(
        env.TestRetryAgent,
        "validate-fractional"
      );
      const { error } = await stub.retryWithFractionalAttempts();
      expect(error).toBe("retry.maxAttempts must be an integer");
    });
  });

  // ── class-level defaults ─────────────────────────────────────────

  describe("class-level retry defaults (static options)", () => {
    it("uses class-level maxAttempts=5 by default", async () => {
      const stub = await getAgentByName(
        env.TestRetryDefaultsAgent,
        "defaults-succeed"
      );
      const { result, attempts } = await stub.retryUsingDefaults();
      expect(result).toBe("ok-5");
      expect(attempts).toEqual([1, 2, 3, 4, 5]);
    });

    it("exhausts after class-level maxAttempts", async () => {
      const stub = await getAgentByName(
        env.TestRetryDefaultsAgent,
        "defaults-exhaust"
      );
      const { error } = await stub.retryExceedingDefaults();
      expect(error).toBe("always-fail-5");
    });

    it("allows per-call override of class-level defaults", async () => {
      const stub = await getAgentByName(
        env.TestRetryDefaultsAgent,
        "defaults-override"
      );
      const { result, attempts } = await stub.retryWithOverride();
      expect(result).toBe("ok-2");
      expect(attempts).toEqual([1, 2]);
    });
  });
});
