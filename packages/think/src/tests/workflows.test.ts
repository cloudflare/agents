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
      retries?: {
        maxAttempts?: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
      };
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
        waitForEvent: async () => waitEvent,
        sleep: async () => {}
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

    it("keeps stable step names on the first attempt for in-flight replay", async () => {
      const doNames: string[] = [];
      const waitNames: string[] = [];

      const agent: FakeThinkAgent = {
        async submitMessages() {
          return createSubmissionResult("submission-1", () => {});
        },
        async cancelSubmission() {
          throw new Error("cancelSubmission should not be called");
        }
      };

      const step = {
        do: async (name: string, callback: () => Promise<unknown>) => {
          doNames.push(name);
          return callback();
        },
        waitForEvent: async (name: string) => {
          waitNames.push(name);
          return {
            payload: {
              submissionId: "submission-1",
              status: "completed",
              output: { answer: "done" }
            },
            [Symbol.dispose]: () => {}
          };
        },
        sleep: async () => {}
      } as unknown as AgentWorkflowStep;

      const workflow = createWorkflow(agent);
      await workflow._promptStep(
        "structure",
        {
          prompt: "Return structured output",
          output: z.object({ answer: z.string() })
        },
        step,
        createEvent()
      );

      // The default (non-retry) path must reuse the historical step names so
      // workflows that hibernated on an older version replay without
      // re-executing already-completed steps.
      expect(doNames).toContain("structure:submit");
      expect(doNames).not.toContain("structure:submit-0");
      expect(waitNames).toContain("structure:wait");
      expect(waitNames).not.toContain("structure:wait-0");
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
        waitForEvent: async () => waitEvent,
        sleep: async () => {}
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
        },
        sleep: async () => {}
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

    it("retries transient prompt errors with backoff and fresh submissions", async () => {
      let submitCount = 0;
      const sleepCalls: Array<{ name: string; duration: number }> = [];

      const agent: FakeThinkAgent = {
        async submitMessages() {
          submitCount++;
          return createSubmissionResult(`submission-${submitCount}`, () => {});
        },
        async cancelSubmission() {
          throw new Error("cancelSubmission should not be called");
        }
      };

      const step = {
        do: async (_name: string, callback: () => Promise<unknown>) => {
          return callback();
        },
        waitForEvent: async () => {
          if (submitCount < 3) {
            return {
              payload: {
                submissionId: `submission-${submitCount}`,
                status: "error",
                error: "3040: Capacity temporarily exceeded"
              },
              [Symbol.dispose]: () => {}
            };
          }
          return {
            payload: {
              submissionId: `submission-${submitCount}`,
              status: "completed",
              output: { answer: "finally" }
            },
            [Symbol.dispose]: () => {}
          };
        },
        sleep: async (name: string, duration: number) => {
          sleepCalls.push({ name, duration });
        }
      } as unknown as AgentWorkflowStep;

      const workflow = createWorkflow(agent);
      const output = await workflow._promptStep(
        "structure",
        {
          prompt: "Return structured output",
          output: z.object({ answer: z.string() }),
          retries: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }
        },
        step,
        createEvent()
      );

      expect(output).toEqual({ answer: "finally" });
      expect(submitCount).toBe(3);
      expect(sleepCalls.length).toBe(2);
      expect(sleepCalls[0].name).toBe("structure:retry-0");
      expect(sleepCalls[1].name).toBe("structure:retry-1");
      expect(sleepCalls[0].duration).toBeGreaterThanOrEqual(0);
      expect(sleepCalls[0].duration).toBeLessThanOrEqual(100);
      expect(sleepCalls[1].duration).toBeGreaterThanOrEqual(0);
      expect(sleepCalls[1].duration).toBeLessThanOrEqual(200);
      // Jitter must actually be applied — guard against the backoff collapsing
      // to ~0ms (e.g. a degenerate fraction), which would cause thundering-herd
      // retries. The delay is deterministic for fixed inputs.
      expect(sleepCalls.some((call) => call.duration > 0)).toBe(true);
    });

    it("retries any prompt error, including validation failures", async () => {
      let attempt = 0;
      const sleepCalls: Array<{ name: string; duration: number }> = [];

      const agent: FakeThinkAgent = {
        async submitMessages() {
          attempt++;
          return createSubmissionResult(`submission-${attempt}`, () => {});
        },
        async cancelSubmission() {
          /* best-effort */
        }
      };

      const step = {
        do: async (_name: string, callback: () => Promise<unknown>) => {
          return callback();
        },
        waitForEvent: async () => {
          return {
            payload: {
              submissionId: `submission-${attempt}`,
              status: "completed",
              output: attempt < 2 ? { unexpected: "shape" } : { answer: "ok" }
            },
            [Symbol.dispose]: () => {}
          };
        },
        sleep: async (name: string, duration: number) => {
          sleepCalls.push({ name, duration });
        }
      } as unknown as AgentWorkflowStep;

      const workflow = createWorkflow(agent);
      const output = await workflow._promptStep(
        "structure",
        {
          prompt: "Return structured output",
          output: z.object({ answer: z.string() }),
          retries: { maxAttempts: 3 }
        },
        step,
        createEvent()
      );

      expect(output).toEqual({ answer: "ok" });
      expect(attempt).toBe(2);
      expect(sleepCalls.length).toBe(1);
      expect(sleepCalls[0].name).toBe("structure:retry-0");
    });

    it("throws the last error after exhausting all attempts", async () => {
      let attempt = 0;
      const sleepCalls: Array<{ name: string; duration: number }> = [];

      const agent: FakeThinkAgent = {
        async submitMessages() {
          attempt++;
          return createSubmissionResult(`submission-${attempt}`, () => {});
        },
        async cancelSubmission() {
          /* best-effort */
        }
      };

      const step = {
        do: async (_name: string, callback: () => Promise<unknown>) => {
          return callback();
        },
        waitForEvent: async () => {
          return {
            payload: {
              submissionId: `submission-${attempt}`,
              status: "error",
              error: "3040: Capacity temporarily exceeded"
            },
            [Symbol.dispose]: () => {}
          };
        },
        sleep: async (name: string, duration: number) => {
          sleepCalls.push({ name, duration });
        }
      } as unknown as AgentWorkflowStep;

      const workflow = createWorkflow(agent);
      await expect(
        workflow._promptStep(
          "structure",
          {
            prompt: "Return structured output",
            output: z.object({ answer: z.string() }),
            retries: { maxAttempts: 2 }
          },
          step,
          createEvent()
        )
      ).rejects.toThrow("3040: Capacity temporarily exceeded");

      expect(attempt).toBe(2);
      expect(sleepCalls.length).toBe(1);
    });
  });
});
