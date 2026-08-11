import { describe, expect, it, vi } from "vitest";
import { RlmThinkAgent } from "../src/agent";
import type { InputMeta } from "../src/store";

type Submission = {
  submissionId: string;
  status: "pending" | "running" | "completed" | "error";
  error?: string;
  accepted?: boolean;
};

function repairAgent() {
  const meta: InputMeta = {
    id: "input-one",
    scope: "root",
    requestId: "request-one",
    kind: "think",
    taskChars: 4,
    materialChars: 8,
    createdAt: 1
  };
  const submissions = new Map<string, Submission>([
    [meta.id, { submissionId: meta.id, status: "completed" }]
  ]);
  let answer:
    | {
        inputId: string;
        content: string;
        executionId: string;
        verified: boolean;
        createdAt: number;
      }
    | undefined;
  const store = {
    inputForRequest: vi.fn(() => meta),
    inputSlice: vi.fn(() => ({ content: "task" })),
    answerRecord: vi.fn(() => answer),
    rlmCalls: vi.fn(() => 2)
  };
  const inspectSubmission = vi.fn(async (id: string) => submissions.get(id));
  const submitMessages = vi.fn(
    async (
      _messages: unknown[],
      options: { submissionId: string; idempotencyKey: string }
    ) => {
      const existing = submissions.get(options.submissionId);
      if (existing) return { ...existing, accepted: false };
      const admitted: Submission = {
        submissionId: options.submissionId,
        status: "pending",
        accepted: true
      };
      submissions.set(options.submissionId, admitted);
      return admitted;
    }
  );
  const agent = Object.create(RlmThinkAgent.prototype) as RlmThinkAgent;
  Object.defineProperties(agent, {
    store: { value: store },
    inspectSubmission: { value: inspectSubmission },
    submitMessages: { value: submitMessages }
  });
  return {
    agent,
    meta,
    submissions,
    submitMessages,
    finishRepair(content?: string) {
      const repair = [...submissions.values()].find(
        (submission) => submission.submissionId !== meta.id
      );
      if (!repair) throw new Error("repair was not admitted");
      repair.status = "completed";
      if (content) {
        answer = {
          inputId: meta.id,
          content,
          executionId: "repair-execution",
          verified: true,
          createdAt: 2
        };
      }
    }
  };
}

describe("RlmThinkAgent terminal repair", () => {
  it("admits one durable semantic repair and never loops", async () => {
    const harness = repairAgent();

    await expect(harness.agent.requestStatus("request-one")).resolves.toEqual({
      requestId: "request-one",
      kind: "think",
      status: "admitted",
      inputId: "input-one"
    });
    await expect(harness.agent.requestStatus("request-one")).resolves.toEqual({
      requestId: "request-one",
      kind: "think",
      status: "admitted",
      inputId: "input-one"
    });

    expect(harness.submitMessages).toHaveBeenCalledOnce();
    const [messages, options] = harness.submitMessages.mock.calls[0];
    expect(options.submissionId).toBe(options.idempotencyKey);
    expect(options.submissionId).not.toBe("input-one");
    expect(messages).toEqual([
      expect.objectContaining({
        id: "rlm-repair-input-one",
        parts: [
          expect.objectContaining({
            text: expect.stringContaining(
              "Recover useful kernel state from the prior pass and finish through kernel.finish."
            )
          })
        ]
      })
    ]);

    harness.finishRepair();
    await expect(harness.agent.requestStatus("request-one")).resolves.toEqual({
      requestId: "request-one",
      kind: "think",
      status: "error",
      inputId: "input-one",
      recursiveCalls: 2,
      error:
        "turn and its one automatic repair completed without a valid kernel.finish"
    });
    expect(harness.submitMessages).toHaveBeenCalledOnce();
  });

  it("serves an answer verified by the repair", async () => {
    const harness = repairAgent();
    await harness.agent.requestStatus("request-one");
    harness.finishRepair("fixed answer");

    await expect(harness.agent.requestStatus("request-one")).resolves.toEqual({
      requestId: "request-one",
      kind: "think",
      status: "completed",
      inputId: "input-one",
      answer: "fixed answer",
      executionIds: ["repair-execution"],
      recursiveCalls: 2
    });
    expect(harness.submitMessages).toHaveBeenCalledOnce();
  });
});
