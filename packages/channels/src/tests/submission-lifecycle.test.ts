import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_DELIVERY_POLICY, retryDelayMs } from "../delivery-policy";
import {
  SubmissionStore,
  type SubmissionStoreOptions
} from "../storage/submission-store";
import { exampleSubmissionInput, submissionStoreStub } from "./test-utils";

const START = Date.parse("2026-06-11T12:00:00.000Z");

function deterministicOptions(
  time: { now: number },
  policy: SubmissionStoreOptions["policy"] = {}
): SubmissionStoreOptions {
  return {
    clock: () => time.now,
    random: () => 1,
    policy: { baseRetryDelayMs: 1_000, maxRetryDelayMs: 8_000, ...policy }
  };
}

function failAttempt(store: SubmissionStore, submissionId: string): void {
  const claimed = store.beginAgentDeliveryAttempt(submissionId);
  if (claimed === undefined) {
    throw new Error(`Expected ${submissionId} to be claimable`);
  }
  store.completeAgentDeliveryAttempt(claimed.attempt.attemptId, {
    outcome: "retryable_error",
    errorDescription: "simulated transient failure"
  });
}

describe("retry backoff schedule", () => {
  it("computes bounded exponential delays with equal jitter", () => {
    const policy = {
      ...DEFAULT_DELIVERY_POLICY,
      baseRetryDelayMs: 1_000,
      maxRetryDelayMs: 8_000
    };
    // random() => 0 pins the low edge (cap / 2); => 1 pins the cap itself.
    expect(retryDelayMs(policy, 0, () => 0)).toBe(500);
    expect(retryDelayMs(policy, 0, () => 1)).toBe(1_000);
    expect(retryDelayMs(policy, 1, () => 1)).toBe(2_000);
    expect(retryDelayMs(policy, 2, () => 1)).toBe(4_000);
    expect(retryDelayMs(policy, 3, () => 1)).toBe(8_000);
    // The exponential schedule is capped, not unbounded.
    expect(retryDelayMs(policy, 10, () => 1)).toBe(8_000);
    expect(retryDelayMs(policy, 10, () => 0.5)).toBe(6_000);
  });

  it("persists the growing schedule and retry count across failures", async () => {
    // Arrange
    const stub = submissionStoreStub(`backoff-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time, { maxAttemptsPerCycle: 10 })
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }

      const schedule: Array<{ retryCount: number; nextAttemptAt?: string }> =
        [];
      for (const _ of [1, 2, 3, 4]) {
        failAttempt(store, accepted.submissionId);
        const status = store.getStatus(accepted.submissionId);
        schedule.push({
          retryCount: status?.retryCount ?? -1,
          nextAttemptAt: status?.nextAttemptAt
        });
        // Jump to exactly when the retry becomes due.
        time.now = Date.parse(status?.nextAttemptAt ?? "");
      }
      return schedule;
    });

    // Assert: 1s, 2s, 4s, then capped at 8s — each persisted durably.
    let expected = START;
    const delays = [1_000, 2_000, 4_000, 8_000];
    result.forEach((entry, index) => {
      expected += delays[index];
      expect(entry).toEqual({
        retryCount: index + 1,
        nextAttemptAt: new Date(expected).toISOString()
      });
    });
  });
});

describe("dispatch leases", () => {
  it("refuses a second claim while the lease is unexpired", async () => {
    // Arrange
    const stub = submissionStoreStub(`lease-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time)
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      const claimed = store.beginAgentDeliveryAttempt(accepted.submissionId);
      const competing = store.beginAgentDeliveryAttempt(accepted.submissionId);
      return {
        claimed,
        competing,
        status: store.getStatus(accepted.submissionId)
      };
    });

    // Assert
    expect(result.claimed?.attempt.attemptNumber).toBe(1);
    expect(result.competing).toBeUndefined();
    expect(result.status).toMatchObject({
      state: "delivering",
      leaseExpiresAt: new Date(
        START + DEFAULT_DELIVERY_POLICY.leaseDurationMs
      ).toISOString()
    });
  });

  it("recovers an expired lease into a scheduled retry", async () => {
    // Arrange
    const stub = submissionStoreStub(`lease-expiry-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time)
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      const claimed = store.beginAgentDeliveryAttempt(accepted.submissionId);
      if (claimed === undefined) {
        throw new Error("Expected the first claim to succeed");
      }

      // The worker crashes: no completion arrives and the lease runs out.
      time.now += DEFAULT_DELIVERY_POLICY.leaseDurationMs;
      const recovered = store.recoverExpiredLeases();

      // The crashed worker's late result must not mutate anything.
      const stale = store.completeAgentDeliveryAttempt(
        claimed.attempt.attemptId,
        { outcome: "acknowledged" }
      );

      return {
        recovered,
        stale,
        attempts: store.listAgentDeliveryAttempts(accepted.submissionId),
        status: store.getStatus(accepted.submissionId)
      };
    });

    // Assert
    expect(result.recovered).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      attemptNumber: 1,
      outcome: "lease_expired"
    });
    expect(result.status).toMatchObject({ state: "retrying", retryCount: 1 });
    expect(result.stale).toBeUndefined();
    expect(result.status?.state).toBe("retrying");
  });

  it("recovers a targeted expired lease when claiming, without hot-looping", async () => {
    // Arrange
    const stub = submissionStoreStub(`lease-claim-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time)
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      store.beginAgentDeliveryAttempt(accepted.submissionId);
      time.now += DEFAULT_DELIVERY_POLICY.leaseDurationMs;

      // Claiming an expired-lease submission recovers it but schedules the
      // next attempt with backoff instead of claiming immediately.
      const immediate = store.beginAgentDeliveryAttempt(accepted.submissionId);
      const scheduled = store.getStatus(accepted.submissionId);
      time.now = Date.parse(scheduled?.nextAttemptAt ?? "");
      const afterBackoff = store.beginAgentDeliveryAttempt(
        accepted.submissionId
      );
      return { immediate, scheduled, afterBackoff };
    });

    // Assert
    expect(result.immediate).toBeUndefined();
    expect(result.scheduled).toMatchObject({ state: "retrying" });
    expect(result.afterBackoff?.attempt.attemptNumber).toBe(2);
  });
});

describe("terminal failure and replay", () => {
  it("dead-letters after the attempt limit and preserves history", async () => {
    // Arrange
    const stub = submissionStoreStub(`dead-letter-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time, { maxAttemptsPerCycle: 2 })
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }

      failAttempt(store, accepted.submissionId);
      time.now += 10_000;
      failAttempt(store, accepted.submissionId);
      const afterLimit = store.beginAgentDeliveryAttempt(accepted.submissionId);
      return {
        afterLimit,
        attempts: store.listAgentDeliveryAttempts(accepted.submissionId),
        status: store.getStatus(accepted.submissionId),
        submission: store.get(accepted.submissionId)
      };
    });

    // Assert
    expect(result.status).toMatchObject({
      state: "failed",
      attemptCount: 2,
      terminalError: expect.stringContaining("Retry limit of 2 attempts")
    });
    expect(result.afterLimit).toBeUndefined();
    // Dead-lettering preserves the submission and its attempt history.
    expect(result.submission?.envelope).toMatchObject(exampleSubmissionInput());
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every((a) => a.outcome === "retryable_error")).toBe(
      true
    );
  });

  it("dead-letters when the delivery cycle exceeds its age limit", async () => {
    // Arrange
    const stub = submissionStoreStub(`age-limit-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time, { maxCycleAgeMs: 60_000 })
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      failAttempt(store, accepted.submissionId);
      time.now = START + 120_000;
      const overdueClaim = store.beginAgentDeliveryAttempt(
        accepted.submissionId
      );
      return { overdueClaim, status: store.getStatus(accepted.submissionId) };
    });

    // Assert
    expect(result.overdueClaim).toBeUndefined();
    expect(result.status).toMatchObject({
      state: "failed",
      terminalError: expect.stringContaining("age limit")
    });
  });

  it("replays a failed submission with the same turn ID and a fresh budget", async () => {
    // Arrange
    const stub = submissionStoreStub(`replay-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time, { maxAttemptsPerCycle: 1 })
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      const originalTurn = store.getAgentDelivery(accepted.submissionId);

      failAttempt(store, accepted.submissionId);
      const failed = store.getStatus(accepted.submissionId);

      const rejected = store.replay("sub_missing", {
        requestedBy: "operator@example.com"
      });
      time.now += 60_000;
      const replayed = store.replay(accepted.submissionId, {
        requestedBy: "operator@example.com"
      });
      const claimed = store.beginAgentDeliveryAttempt(accepted.submissionId);
      if (claimed === undefined) {
        throw new Error("Expected the replayed submission to be claimable");
      }
      store.completeAgentDeliveryAttempt(claimed.attempt.attemptId, {
        outcome: "acknowledged"
      });
      const secondReplay = store.replay(accepted.submissionId, {
        requestedBy: "operator@example.com"
      });
      return {
        originalTurn,
        failed,
        rejected,
        replayed,
        claimed,
        secondReplay,
        replays: store.listReplays(accepted.submissionId),
        attempts: store.listAgentDeliveryAttempts(accepted.submissionId),
        status: store.getStatus(accepted.submissionId)
      };
    });

    // Assert
    expect(result.failed?.state).toBe("failed");
    expect(result.rejected).toEqual({ outcome: "not_found" });
    expect(result.replayed).toMatchObject({
      outcome: "replayed",
      replay: {
        replayId: expect.stringMatching(/^replay_/),
        requestedBy: "operator@example.com",
        requestedAt: new Date(START + 60_000).toISOString()
      }
    });
    // The turn identity is retained and attempt numbering continues.
    expect(result.claimed.delivery.turnId).toBe(result.originalTurn?.turnId);
    expect(result.attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
    expect(result.attempts[0].outcome).toBe("retryable_error");
    expect(result.status).toMatchObject({
      state: "delivered",
      replayCount: 1
    });
    // Replay cleared the terminal error along with the failed state.
    expect(result.status?.terminalError).toBeUndefined();
    expect(result.replays).toHaveLength(1);
    // Delivered submissions cannot be replayed.
    expect(result.secondReplay).toEqual({
      outcome: "not_replayable",
      state: "delivered"
    });
  });
});

describe("cancellation", () => {
  it("stops further delivery and refuses terminal cancellation", async () => {
    // Arrange
    const stub = submissionStoreStub(`cancel-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time)
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      const cancelled = store.cancel(accepted.submissionId);
      const claimAfterCancel = store.beginAgentDeliveryAttempt(
        accepted.submissionId
      );
      const again = store.cancel(accepted.submissionId);
      const missing = store.cancel("sub_missing");
      return {
        cancelled,
        claimAfterCancel,
        again,
        missing,
        status: store.getStatus(accepted.submissionId)
      };
    });

    // Assert
    expect(result.cancelled).toEqual({ outcome: "cancelled" });
    expect(result.claimAfterCancel).toBeUndefined();
    expect(result.status?.state).toBe("cancelled");
    expect(result.again).toEqual({
      outcome: "not_cancellable",
      state: "cancelled"
    });
    expect(result.missing).toEqual({ outcome: "not_found" });
  });

  it("keeps a cancelled submission cancelled when a late result arrives", async () => {
    // Arrange
    const stub = submissionStoreStub(`cancel-race-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time)
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      const claimed = store.beginAgentDeliveryAttempt(accepted.submissionId);
      if (claimed === undefined) {
        throw new Error("Expected the claim to succeed");
      }
      const cancelled = store.cancel(accepted.submissionId);
      const lateResult = store.completeAgentDeliveryAttempt(
        claimed.attempt.attemptId,
        { outcome: "acknowledged" }
      );
      return {
        cancelled,
        lateResult,
        status: store.getStatus(accepted.submissionId)
      };
    });

    // Assert
    expect(result.cancelled).toEqual({ outcome: "cancelled" });
    expect(result.lateResult).toBeUndefined();
    expect(result.status?.state).toBe("cancelled");
  });
});

describe("submission status", () => {
  it("projects delivery progress without exposing the payload", async () => {
    // Arrange
    const stub = submissionStoreStub(`status-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time)
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      const initial = store.getStatus(accepted.submissionId);
      failAttempt(store, accepted.submissionId);
      time.now += 5_000;
      return {
        initial,
        afterFailure: store.getStatus(accepted.submissionId),
        listed: store.listStatuses(),
        missing: store.getStatus("sub_missing")
      };
    });

    // Assert
    expect(result.initial).toEqual({
      submissionId: expect.stringMatching(/^sub_/),
      turnId: expect.stringMatching(/^turn_/),
      state: "pending",
      agentTarget: "support-agent/acme",
      sourceType: "slack-webhook",
      createdAt: new Date(START).toISOString(),
      attemptCount: 0,
      retryCount: 0,
      replayCount: 0,
      nextAttemptAt: new Date(START).toISOString()
    });
    expect(result.afterFailure).toMatchObject({
      state: "retrying",
      attemptCount: 1,
      retryCount: 1,
      lastOutcome: "retryable_error",
      lastAttemptAt: new Date(START).toISOString(),
      nextAttemptAt: new Date(START + 1_000).toISOString()
    });
    // The status projection must not leak message content.
    const serialized = JSON.stringify([result.initial, result.afterFailure]);
    expect(serialized).not.toContain("Where is order 1234?");
    expect(serialized).not.toContain("thread");
    expect(result.listed).toHaveLength(1);
    expect(result.missing).toBeUndefined();
  });
});
