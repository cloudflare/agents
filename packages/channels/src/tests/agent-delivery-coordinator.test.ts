import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AgentDeliveryCoordinator } from "../agent-delivery-coordinator";
import { AgentDispatcher, type AgentTurnRequest } from "../agent-dispatch";
import { SubmissionStore } from "../storage/submission-store";
import { exampleSubmissionInput, submissionStoreStub } from "./test-utils";

describe("AgentDeliveryCoordinator", () => {
  it("records each physical dispatch with stable logical identities", async () => {
    // Arrange
    const stub = submissionStoreStub(`attempts-${crypto.randomUUID()}`);

    // Act
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const store = new SubmissionStore(state.storage);
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
          }
        }))
      );

      // Each awaited dispatch settles and durably terminates its attempt before
      // returning, so both returned attempts include an end time.
      const first = await coordinator.dispatch(accepted.submissionId);
      const second = await coordinator.dispatch(accepted.submissionId);
      return {
        attempts: store.listAgentDeliveryAttempts(accepted.submissionId),
        first,
        requests,
        second,
        submission: store.get(accepted.submissionId)
      };
    });

    // Assert
    expect(result.first).toMatchObject({
      attemptId: expect.stringMatching(/^attempt_/),
      attemptNumber: 1,
      outcome: "dispatch_returned"
    });
    expect(result.second).toMatchObject({
      attemptId: expect.stringMatching(/^attempt_/),
      attemptNumber: 2,
      outcome: "dispatch_returned"
    });
    expect(result.second?.attemptId).not.toBe(result.first?.attemptId);
    expect(result.attempts).toEqual([result.first, result.second]);
    // TODO(item 13): Inject a clock so exact start and end times can be asserted.
    expect(result.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          startedAt: expect.stringMatching(/^2026-|^20/),
          endedAt: expect.any(String)
        })
      ])
    );
    expect(result.requests).toHaveLength(2);
    expect(result.requests[0].submission.submissionId).toBe(
      result.requests[1].submission.submissionId
    );
    expect(result.requests[0].turnId).toBe(result.requests[1].turnId);
    expect(result.requests[0].turnId).toBe(result.first?.turnId);
    expect(result.submission?.state).toBe("retrying");
  });

  it("records and bounds dispatch errors", async () => {
    // Arrange
    const stub = submissionStoreStub(`attempt-error-${crypto.randomUUID()}`);
    const message = "x".repeat(2048);

    // Act
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const store = new SubmissionStore(state.storage);
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      const coordinator = new AgentDeliveryCoordinator(
        store,
        new AgentDispatcher(() => ({
          async receiveTurn() {
            throw new Error(message);
          }
        }))
      );
      const attempt = await coordinator.dispatch(accepted.submissionId);
      return {
        attempt,
        submission: store.get(accepted.submissionId)
      };
    });

    // Assert
    expect(result.attempt).toMatchObject({
      attemptNumber: 1,
      outcome: "dispatch_error",
      errorDescription: "x".repeat(1024)
    });
    expect(result.submission?.state).toBe("retrying");
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
          async receiveTurn() {
            dispatchCount += 1;
            await Promise.resolve();
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
