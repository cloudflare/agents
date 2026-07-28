import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AgentDeliveryCoordinator } from "../agent-delivery-coordinator";
import { AgentDispatcher, type AgentTurnRequest } from "../agent-dispatch";
import { PermanentDispatchError } from "../retry-classification";
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
    // random() => 1 pins equal jitter to the capped exponential delay.
    random: () => 1,
    policy: { baseRetryDelayMs: 1_000, maxRetryDelayMs: 60_000, ...policy }
  };
}

describe("AgentDeliveryCoordinator", () => {
  it("marks a submission delivered on a turn-bound acknowledgement", async () => {
    // Arrange
    const stub = submissionStoreStub(`ack-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time)
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      const requests: AgentTurnRequest[] = [];
      const coordinator = new AgentDeliveryCoordinator(
        store,
        new AgentDispatcher(() => ({
          async receiveTurn(request) {
            requests.push(request);
            return { turnId: request.turnId };
          }
        }))
      );

      const attempt = await coordinator.dispatch(accepted.submissionId);
      const afterDelivery = await coordinator.dispatch(accepted.submissionId);
      return {
        attempt,
        afterDelivery,
        requests,
        submission: store.get(accepted.submissionId)
      };
    });

    // Assert
    expect(result.attempt).toMatchObject({
      attemptId: expect.stringMatching(/^attempt_/),
      attemptNumber: 1,
      outcome: "acknowledged",
      startedAt: new Date(START).toISOString(),
      endedAt: new Date(START).toISOString()
    });
    expect(result.submission?.state).toBe("delivered");
    // Delivered is terminal for automatic processing: no further claims.
    expect(result.afterDelivery).toBeUndefined();
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].turnId).toBe(result.attempt?.turnId);
  });

  it("treats a return without a turn-bound acknowledgement as undelivered", async () => {
    // Arrange
    const stub = submissionStoreStub(`unack-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time)
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      const coordinator = new AgentDeliveryCoordinator(
        store,
        new AgentDispatcher(() => ({
          async receiveTurn() {
            return { turnId: "turn_someone_else" };
          }
        }))
      );
      const attempt = await coordinator.dispatch(accepted.submissionId);
      return { attempt, submission: store.get(accepted.submissionId) };
    });

    // Assert
    expect(result.attempt).toMatchObject({
      outcome: "unacknowledged",
      errorDescription: expect.stringContaining("without acknowledging turn")
    });
    expect(result.submission?.state).toBe("retrying");
  });

  it("retries transient errors with stable logical identities", async () => {
    // Arrange
    const stub = submissionStoreStub(`retry-${crypto.randomUUID()}`);
    const time = { now: START };
    const message = "x".repeat(2048);

    // Act
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time)
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      const requests: AgentTurnRequest[] = [];
      let failuresRemaining = 1;
      const coordinator = new AgentDeliveryCoordinator(
        store,
        new AgentDispatcher(() => ({
          async receiveTurn(request) {
            requests.push(request);
            if (failuresRemaining > 0) {
              failuresRemaining -= 1;
              throw new Error(message);
            }
            return { turnId: request.turnId };
          }
        }))
      );

      const first = await coordinator.dispatch(accepted.submissionId);
      const whileBackingOff = await coordinator.dispatch(accepted.submissionId);
      const scheduled = store.getStatus(accepted.submissionId);
      time.now += 1_000;
      const second = await coordinator.dispatch(accepted.submissionId);
      return {
        first,
        whileBackingOff,
        scheduled,
        second,
        requests,
        attempts: store.listAgentDeliveryAttempts(accepted.submissionId),
        submission: store.get(accepted.submissionId)
      };
    });

    // Assert
    expect(result.first).toMatchObject({
      attemptNumber: 1,
      outcome: "retryable_error",
      errorDescription: "x".repeat(1024)
    });
    // The retry is scheduled with backoff, so an early claim is refused.
    expect(result.whileBackingOff).toBeUndefined();
    expect(result.scheduled).toMatchObject({
      state: "retrying",
      retryCount: 1,
      nextAttemptAt: new Date(START + 1_000).toISOString()
    });
    expect(result.second).toMatchObject({
      attemptNumber: 2,
      outcome: "acknowledged"
    });
    expect(result.second?.attemptId).not.toBe(result.first?.attemptId);
    expect(result.attempts).toEqual([result.first, result.second]);
    expect(result.requests).toHaveLength(2);
    expect(result.requests[0].turnId).toBe(result.requests[1].turnId);
    expect(result.submission?.state).toBe("delivered");
  });

  it("fails immediately on a permanently classified error", async () => {
    // Arrange
    const stub = submissionStoreStub(`permanent-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time)
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      const coordinator = new AgentDeliveryCoordinator(
        store,
        new AgentDispatcher(() => ({
          async receiveTurn() {
            throw new PermanentDispatchError("agent rejected malformed input");
          }
        }))
      );
      const attempt = await coordinator.dispatch(accepted.submissionId);
      const afterFailure = await coordinator.dispatch(accepted.submissionId);
      return {
        attempt,
        afterFailure,
        status: store.getStatus(accepted.submissionId)
      };
    });

    // Assert
    expect(result.attempt).toMatchObject({
      attemptNumber: 1,
      outcome: "permanent_error",
      errorDescription: "agent rejected malformed input"
    });
    expect(result.status).toMatchObject({
      state: "failed",
      terminalError: "agent rejected malformed input"
    });
    expect(result.afterFailure).toBeUndefined();
  });

  it("classifies a dispatch timeout separately and releases the claim", async () => {
    // Arrange
    const stub = submissionStoreStub(`timeout-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time)
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      const coordinator = new AgentDeliveryCoordinator(
        store,
        new AgentDispatcher(() => ({
          receiveTurn() {
            return new Promise(() => {});
          }
        })),
        { dispatchTimeoutMs: 5 }
      );
      const attempt = await coordinator.dispatch(accepted.submissionId);
      return { attempt, status: store.getStatus(accepted.submissionId) };
    });

    // Assert
    expect(result.attempt).toMatchObject({
      attemptNumber: 1,
      outcome: "timeout"
    });
    // The timed-out attempt released its claim: the submission is scheduled
    // to retry rather than stuck in delivering under a held lease.
    expect(result.status).toMatchObject({ state: "retrying", retryCount: 1 });
    expect(result.status?.leaseExpiresAt).toBeUndefined();
  });

  it("allows only one active attempt to claim a submission", async () => {
    // Arrange
    const stub = submissionStoreStub(`attempt-claim-${crypto.randomUUID()}`);

    // Act
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const store = new SubmissionStore(state.storage);
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      let dispatchCount = 0;
      const coordinator = new AgentDeliveryCoordinator(
        store,
        new AgentDispatcher(() => ({
          async receiveTurn(request) {
            dispatchCount += 1;
            await Promise.resolve();
            return { turnId: request.turnId };
          }
        }))
      );

      const [first, competing] = await Promise.all([
        coordinator.dispatch(accepted.submissionId),
        coordinator.dispatch(accepted.submissionId)
      ]);
      return { competing, dispatchCount, first };
    });

    // Assert
    expect(result.first).toMatchObject({ attemptNumber: 1 });
    expect(result.competing).toBeUndefined();
    expect(result.dispatchCount).toBe(1);
  });
});
