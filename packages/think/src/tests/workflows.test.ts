import type { WorkflowEvent } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z, type ZodObject } from "zod";
import type { AgentWorkflowStep } from "agents/workflows";
import type { SubmitMessagesResult } from "../think";
import { ThinkPromptTimeoutError, ThinkWorkflow } from "../workflows";

type PromptStepRunner = {
  _promptStep<Schema extends ZodObject>(
    stepName: string,
    options: {
      prompt: string;
      output: Schema;
      timeout?: string;
      key?: string;
      cancelOnTimeout?: boolean;
    },
    step: AgentWorkflowStep,
    event: WorkflowEvent<unknown>
  ): Promise<z.infer<Schema>>;
};

type DisposableSubmissionResult = SubmitMessagesResult & {
  extraRpcField: string;
  [Symbol.dispose](): void;
};

type FakeThinkAgent = {
  submitMessages(): Promise<DisposableSubmissionResult>;
  cancelSubmission(submissionId: string, reason: string): Promise<void>;
};

function createWorkflow(agent: FakeThinkAgent): PromptStepRunner {
  return Object.assign(Object.create(ThinkWorkflow.prototype), {
    _agent: agent,
    _workflowId: "workflow-id",
    _workflowName: "TEST_WORKFLOW"
  }) as PromptStepRunner;
}

function createEvent(): WorkflowEvent<unknown> {
  return {
    instanceId: "workflow-id",
    payload: {}
  } as WorkflowEvent<unknown>;
}

function createSubmissionResult(
  submissionId: string,
  onDispose: () => void
): DisposableSubmissionResult {
  return {
    submissionId,
    accepted: true,
    status: "pending",
    createdAt: Date.now(),
    extraRpcField: "must-not-leave-step-do",
    [Symbol.dispose]: onDispose
  };
}

describe("ThinkWorkflow", () => {
  describe("prompt step RPC disposal", () => {
    it("disposes submitMessages and waitForEvent results after copying serializable data", async () => {
      let submissionDisposeCount = 0;
      let waitEventDisposeCount = 0;
      let submitStepResult: unknown;

      const submissionResult = createSubmissionResult("submission-1", () => {
        submissionDisposeCount++;
      });

      const agent: FakeThinkAgent = {
        async submitMessages() {
          return submissionResult;
        },
        async cancelSubmission() {
          throw new Error("cancelSubmission should not be called");
        }
      };

      const waitEvent = {
        payload: {
          submissionId: "submission-1",
          status: "completed",
          output: { answer: "done" }
        },
        [Symbol.dispose]: () => {
          waitEventDisposeCount++;
        }
      };

      const step = {
        do: async (_name: string, callback: () => Promise<unknown>) => {
          submitStepResult = await callback();
          return submitStepResult;
        },
        waitForEvent: async () => waitEvent
      } as unknown as AgentWorkflowStep;

      const workflow = createWorkflow(agent);
      const output = await workflow._promptStep(
        "structure",
        {
          prompt: "Return structured output",
          output: z.object({ answer: z.string() })
        },
        step,
        createEvent()
      );

      expect(output).toEqual({ answer: "done" });
      expect(submitStepResult).toEqual({ submissionId: "submission-1" });
      expect(submissionDisposeCount).toBe(1);
      expect(waitEventDisposeCount).toBe(1);
    });

    it("keeps the waitForEvent result alive while validating nested output", async () => {
      let waitEventDisposed = false;

      const submissionResult = createSubmissionResult(
        "submission-proxy",
        () => {}
      );
      const agent: FakeThinkAgent = {
        async submitMessages() {
          return submissionResult;
        },
        async cancelSubmission() {
          throw new Error("cancelSubmission should not be called");
        }
      };

      const output = {
        get answer() {
          if (waitEventDisposed) {
            throw new Error("output read after wait event disposal");
          }
          return "still readable";
        }
      };

      const waitEvent = {
        payload: {
          submissionId: "submission-proxy",
          status: "completed",
          output
        },
        [Symbol.dispose]: () => {
          waitEventDisposed = true;
        }
      };

      const step = {
        do: async (_name: string, callback: () => Promise<unknown>) => {
          return callback();
        },
        waitForEvent: async () => waitEvent
      } as unknown as AgentWorkflowStep;

      const workflow = createWorkflow(agent);
      await expect(
        workflow._promptStep(
          "structure",
          {
            prompt: "Return structured output",
            output: z.object({ answer: z.string() })
          },
          step,
          createEvent()
        )
      ).resolves.toEqual({ answer: "still readable" });
      expect(waitEventDisposed).toBe(true);
    });

    it("disposes the submitMessages result before cancelling a timed-out prompt", async () => {
      let submissionDisposeCount = 0;
      const cancelCalls: Array<{ submissionId: string; reason: string }> = [];

      const submissionResult = createSubmissionResult(
        "submission-timeout",
        () => {
          submissionDisposeCount++;
        }
      );

      const agent: FakeThinkAgent = {
        async submitMessages() {
          return submissionResult;
        },
        async cancelSubmission(submissionId: string, reason: string) {
          cancelCalls.push({ submissionId, reason });
        }
      };

      const step = {
        do: async (_name: string, callback: () => Promise<unknown>) => {
          return callback();
        },
        waitForEvent: async () => {
          throw new Error("timed out");
        }
      } as unknown as AgentWorkflowStep;

      const workflow = createWorkflow(agent);

      await expect(
        workflow._promptStep(
          "structure",
          {
            prompt: "Return structured output",
            output: z.object({ answer: z.string() }),
            timeout: "1 minute"
          },
          step,
          createEvent()
        )
      ).rejects.toBeInstanceOf(ThinkPromptTimeoutError);

      expect(submissionDisposeCount).toBe(1);
      expect(cancelCalls).toEqual([
        {
          submissionId: "submission-timeout",
          reason: "Workflow prompt wait timed out"
        }
      ]);
    });
  });
});
