import { describe, expect, it, vi } from "vitest";
import { AgentDispatcher, type AgentTurnRequest } from "../agent-dispatch";
import type { AgentDelivery } from "../agent-deliveries";
import type { SubmissionEnvelope } from "../submissions";
import { exampleSubmissionInput } from "./test-utils";

function exampleEnvelope(
  overrides: Partial<SubmissionEnvelope> = {}
): SubmissionEnvelope {
  return {
    ...exampleSubmissionInput(),
    schemaVersion: 1,
    submissionId: "sub_example",
    createdAt: "2026-06-11T12:34:56.789Z",
    ...overrides
  };
}

describe("AgentDispatcher", () => {
  it("sends the canonical submission and stable turn ID to its target", async () => {
    // Arrange
    const submission = exampleEnvelope();
    const delivery: AgentDelivery = {
      submissionId: submission.submissionId,
      turnId: "turn_example"
    };
    const received: AgentTurnRequest[] = [];
    const resolveTarget = vi.fn(() => ({
      async receiveTurn(request: AgentTurnRequest) {
        received.push(request);
        return { turnId: request.turnId };
      }
    }));
    const dispatcher = new AgentDispatcher(resolveTarget);

    // Act
    const firstAck = await dispatcher.dispatch(submission, delivery);
    const secondAck = await dispatcher.dispatch(submission, delivery);

    // Assert
    expect(resolveTarget).toHaveBeenNthCalledWith(1, submission.agentTarget);
    expect(resolveTarget).toHaveBeenNthCalledWith(2, submission.agentTarget);
    expect(received).toEqual([
      { submission, turnId: delivery.turnId },
      { submission, turnId: delivery.turnId }
    ]);
    expect(firstAck).toEqual({ turnId: delivery.turnId });
    expect(secondAck).toEqual({ turnId: delivery.turnId });
  });

  it("rejects a delivery belonging to another submission", async () => {
    // Arrange
    const submission = exampleEnvelope();
    const resolveTarget = vi.fn();
    const dispatcher = new AgentDispatcher(resolveTarget);

    // Act
    const dispatch = dispatcher.dispatch(submission, {
      submissionId: "sub_another",
      turnId: "turn_example"
    });

    // Assert
    await expect(dispatch).rejects.toThrow(
      "Agent delivery for sub_another cannot dispatch submission sub_example"
    );
    expect(resolveTarget).not.toHaveBeenCalled();
  });
});
