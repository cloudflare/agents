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
        retryOnTimeout?: boolean;
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

type FakeInspectResult = {
  submissionId: string;
  status: string;
};

type FakeThinkAgent = {
  submitMessages(): Promise<DisposableSubmissionResult>;
  cancelSubmission(submissionId: string, reason: string): Promise<void>;
  inspectSubmission?(submissionId: string): Promise<FakeInspectResult | null>;
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
      const cancelCalls: Array<{ submissionId: string; reason: string }> = [];
      const doNames: string[] = [];

      const agent: FakeThinkAgent = {
        async submitMessages() {
          submitCount++;
          return createSubmissionResult(`submission-${submitCount}`, () => {});
        },
        async cancelSubmission(submissionId: string, reason: string) {
          cancelCalls.push({ submissionId, reason });
        }
      };

      const step = {
        do: async (name: string, callback: () => Promise<unknown>) => {
          doNames.push(name);
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
      // Each abandoned attempt is cancelled before retrying so its turn (and
      // any chatRecovery continuation) can't race the fresh attempt.
      expect(cancelCalls).toEqual([
        {
          submissionId: "submission-1",
          reason: "Think workflow retrying prompt step"
        },
        {
          submissionId: "submission-2",
          reason: "Think workflow retrying prompt step"
        }
      ]);
      expect(doNames).toContain("structure:cancel-0");
      expect(doNames).toContain("structure:cancel-1");
      // The successful final attempt (submission-3) is never cancelled.
      expect(
        cancelCalls.some((call) => call.submissionId === "submission-3")
      ).toBe(false);
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

    it("fails fast on timeout when retryOnTimeout is false", async () => {
      let submitCount = 0;
      const sleepCalls: Array<{ name: string; duration: number }> = [];

      const agent: FakeThinkAgent = {
        async submitMessages() {
          submitCount++;
          return createSubmissionResult(`submission-${submitCount}`, () => {});
        },
        async cancelSubmission() {
          /* best-effort cleanup on timeout */
        }
      };

      const step = {
        do: async (_name: string, callback: () => Promise<unknown>) => {
          return callback();
        },
        waitForEvent: async () => {
          throw new Error("timed out");
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
            timeout: "1 minute",
            retries: { maxAttempts: 3, retryOnTimeout: false }
          },
          step,
          createEvent()
        )
      ).rejects.toBeInstanceOf(ThinkPromptTimeoutError);

      // Timeout is not retried: only the first attempt runs and no backoff
      // sleep is scheduled.
      expect(submitCount).toBe(1);
      expect(sleepCalls).toHaveLength(0);
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

    it("rejects invalid retry options eagerly", async () => {
      const workflow = createWorkflow({
        async submitMessages() {
          return createSubmissionResult("submission", () => {});
        },
        async cancelSubmission() {}
      });

      const invalidCases = [
        {
          retries: { maxAttempts: 0 },
          expected: "step.prompt retries.maxAttempts must be >= 1"
        },
        {
          retries: { maxAttempts: 1.5 },
          expected: "step.prompt retries.maxAttempts must be an integer"
        },
        {
          retries: { baseDelayMs: 0 },
          expected: "step.prompt retries.baseDelayMs must be > 0"
        },
        {
          retries: { maxDelayMs: 0 },
          expected: "step.prompt retries.maxDelayMs must be > 0"
        },
        {
          retries: { baseDelayMs: 1000, maxDelayMs: 100 },
          expected:
            "step.prompt retries.baseDelayMs must be <= retries.maxDelayMs"
        }
      ];

      for (const { retries, expected } of invalidCases) {
        await expect(
          workflow._promptStep(
            "structure",
            {
              prompt: "Return structured output",
              output: z.object({ answer: z.string() }),
              retries
            },
            {
              do: async (_name: string, callback: () => Promise<unknown>) =>
                callback(),
              waitForEvent: async () => ({
                payload: {
                  submissionId: "submission",
                  status: "completed",
                  output: { answer: "ok" }
                },
                [Symbol.dispose]: () => {}
              }),
              sleep: async () => {}
            } as unknown as AgentWorkflowStep,
            createEvent()
          )
        ).rejects.toThrow(expected);
      }
    });
  });

  describe("prompt step recovery", () => {
    it("recovers via DO chat recovery instead of re-submitting on timeout", async () => {
      let submitCount = 0;
      let waitCount = 0;
      const doNames: string[] = [];
      const waitNames: string[] = [];
      const cancelCalls: Array<{ submissionId: string; reason: string }> = [];

      const agent: FakeThinkAgent = {
        async submitMessages() {
          submitCount++;
          return createSubmissionResult(`submission-${submitCount}`, () => {});
        },
        async cancelSubmission(submissionId: string, reason: string) {
          cancelCalls.push({ submissionId, reason });
        },
        async inspectSubmission(submissionId: string) {
          return { submissionId, status: "running" };
        }
      };

      const step = {
        do: async (name: string, callback: () => Promise<unknown>) => {
          doNames.push(name);
          return callback();
        },
        waitForEvent: async (name: string) => {
          waitNames.push(name);
          waitCount++;
          if (waitCount === 1) {
            throw new Error("timed out");
          }
          return {
            payload: {
              submissionId: "submission-1",
              status: "completed",
              output: { answer: "recovered" }
            },
            [Symbol.dispose]: () => {}
          };
        },
        sleep: async () => {}
      } as unknown as AgentWorkflowStep;

      const workflow = createWorkflow(agent);
      const output = await workflow._promptStep(
        "structure",
        {
          prompt: "Return structured output",
          output: z.object({ answer: z.string() }),
          timeout: "1 minute",
          retries: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }
        },
        step,
        createEvent()
      );

      expect(output).toEqual({ answer: "recovered" });
      // No fresh submission — the original was recovered
      expect(submitCount).toBe(1);
      // No cancel — recovery succeeded
      expect(cancelCalls).toEqual([]);
      expect(waitCount).toBe(2);
      expect(doNames).toContain("structure:recovery-check-0-0");
      expect(waitNames).toContain("structure:recovery-wait-0-0");
    });

    it("falls back to full retry when submission is dead (error status)", async () => {
      let submitCount = 0;
      let waitCount = 0;
      const doNames: string[] = [];
      const cancelCalls: Array<{ submissionId: string; reason: string }> = [];

      const agent: FakeThinkAgent = {
        async submitMessages() {
          submitCount++;
          return createSubmissionResult(`submission-${submitCount}`, () => {});
        },
        async cancelSubmission(submissionId: string, reason: string) {
          cancelCalls.push({ submissionId, reason });
        },
        async inspectSubmission(submissionId: string) {
          return { submissionId, status: "error" };
        }
      };

      const step = {
        do: async (name: string, callback: () => Promise<unknown>) => {
          doNames.push(name);
          return callback();
        },
        waitForEvent: async () => {
          waitCount++;
          if (waitCount === 1) {
            throw new Error("timed out");
          }
          return {
            payload: {
              submissionId: `submission-${submitCount}`,
              status: "completed",
              output: { answer: "retry" }
            },
            [Symbol.dispose]: () => {}
          };
        },
        sleep: async () => {}
      } as unknown as AgentWorkflowStep;

      const workflow = createWorkflow(agent);
      const output = await workflow._promptStep(
        "structure",
        {
          prompt: "Return structured output",
          output: z.object({ answer: z.string() }),
          timeout: "1 minute",
          retries: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }
        },
        step,
        createEvent()
      );

      expect(output).toEqual({ answer: "retry" });
      // Recovery failed → fresh submission on retry
      expect(submitCount).toBe(2);
      expect(cancelCalls).toEqual([
        {
          submissionId: "submission-1",
          reason: "Think workflow retrying prompt step"
        }
      ]);
      expect(doNames).toContain("structure:recovery-check-0-0");
    });

    it("waits for the DO to come back before recovering (does not resubmit)", async () => {
      // The DO is unreachable for the first two recovery rounds (still
      // restarting after a deploy), then comes back and the original
      // submission completes. Recovery must be patient and NOT discard the
      // in-flight turn by resubmitting.
      let submitCount = 0;
      let inspectCount = 0;
      const doNames: string[] = [];
      const sleepNames: string[] = [];
      const cancelCalls: Array<{ submissionId: string; reason: string }> = [];

      const agent: FakeThinkAgent = {
        async submitMessages() {
          submitCount++;
          return createSubmissionResult(`submission-${submitCount}`, () => {});
        },
        async cancelSubmission(submissionId: string, reason: string) {
          cancelCalls.push({ submissionId, reason });
        },
        async inspectSubmission(submissionId: string) {
          inspectCount++;
          if (inspectCount <= 2) {
            throw new Error("DO is down");
          }
          return { submissionId, status: "running" };
        }
      };

      const step = {
        do: async (name: string, callback: () => Promise<unknown>) => {
          doNames.push(name);
          return callback();
        },
        waitForEvent: async (name: string) => {
          if (name === "structure:wait") {
            throw new Error("timed out");
          }
          return {
            payload: {
              submissionId: "submission-1",
              status: "completed",
              output: { answer: "recovered" }
            },
            [Symbol.dispose]: () => {}
          };
        },
        sleep: async (name: string) => {
          sleepNames.push(name);
        }
      } as unknown as AgentWorkflowStep;

      const workflow = createWorkflow(agent);
      const output = await workflow._promptStep(
        "structure",
        {
          prompt: "Return structured output",
          output: z.object({ answer: z.string() }),
          timeout: "1 minute",
          retries: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }
        },
        step,
        createEvent()
      );

      expect(output).toEqual({ answer: "recovered" });
      // The original submission was recovered — never resubmitted or cancelled.
      expect(submitCount).toBe(1);
      expect(cancelCalls).toEqual([]);
      // Inspected three times: down, down, then up.
      expect(inspectCount).toBe(3);
      // Backed off after each unreachable round before re-checking.
      expect(sleepNames).toEqual([
        "structure:recovery-backoff-0-0",
        "structure:recovery-backoff-0-1"
      ]);
      expect(doNames).toContain("structure:recovery-check-0-2");
    });

    it("re-inspects after a recovery wait times out, then recovers", async () => {
      // Round 0: DO is up (running) but the completion event doesn't arrive in
      // time. Round 1: still running, and this time the event arrives.
      let submitCount = 0;
      let recoveryWaitCount = 0;
      const sleepNames: string[] = [];
      const cancelCalls: Array<{ submissionId: string; reason: string }> = [];

      const agent: FakeThinkAgent = {
        async submitMessages() {
          submitCount++;
          return createSubmissionResult(`submission-${submitCount}`, () => {});
        },
        async cancelSubmission(submissionId: string, reason: string) {
          cancelCalls.push({ submissionId, reason });
        },
        async inspectSubmission(submissionId: string) {
          return { submissionId, status: "running" };
        }
      };

      const step = {
        do: async (_name: string, callback: () => Promise<unknown>) =>
          callback(),
        waitForEvent: async (name: string) => {
          if (name === "structure:wait") {
            throw new Error("timed out");
          }
          if (name.startsWith("structure:recovery-wait-")) {
            recoveryWaitCount++;
            if (recoveryWaitCount === 1) {
              throw new Error("recovery wait timed out");
            }
          }
          return {
            payload: {
              submissionId: "submission-1",
              status: "completed",
              output: { answer: "recovered" }
            },
            [Symbol.dispose]: () => {}
          };
        },
        sleep: async (name: string) => {
          sleepNames.push(name);
        }
      } as unknown as AgentWorkflowStep;

      const workflow = createWorkflow(agent);
      const output = await workflow._promptStep(
        "structure",
        {
          prompt: "Return structured output",
          output: z.object({ answer: z.string() }),
          timeout: "1 minute",
          retries: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }
        },
        step,
        createEvent()
      );

      expect(output).toEqual({ answer: "recovered" });
      expect(submitCount).toBe(1);
      expect(cancelCalls).toEqual([]);
      expect(recoveryWaitCount).toBe(2);
      // Backed off once between the timed-out wait and the next inspection.
      expect(sleepNames).toEqual(["structure:recovery-backoff-0-0"]);
    });

    it("falls back to resubmit when the recovered turn fails terminally", async () => {
      // The DO is alive and drives the submission to a terminal *error* event.
      // Recovery cannot help, so the loop cancels and resubmits a fresh turn.
      let submitCount = 0;
      const cancelCalls: Array<{ submissionId: string; reason: string }> = [];

      const agent: FakeThinkAgent = {
        async submitMessages() {
          submitCount++;
          return createSubmissionResult(`submission-${submitCount}`, () => {});
        },
        async cancelSubmission(submissionId: string, reason: string) {
          cancelCalls.push({ submissionId, reason });
        },
        async inspectSubmission(submissionId: string) {
          return { submissionId, status: "running" };
        }
      };

      const step = {
        do: async (_name: string, callback: () => Promise<unknown>) =>
          callback(),
        waitForEvent: async (name: string) => {
          if (name === "structure:wait") {
            throw new Error("timed out");
          }
          if (name.startsWith("structure:recovery-wait-")) {
            return {
              payload: {
                submissionId: "submission-1",
                status: "error",
                error: "model failed during recovery"
              },
              [Symbol.dispose]: () => {}
            };
          }
          return {
            payload: {
              submissionId: "submission-2",
              status: "completed",
              output: { answer: "fresh" }
            },
            [Symbol.dispose]: () => {}
          };
        },
        sleep: async () => {}
      } as unknown as AgentWorkflowStep;

      const workflow = createWorkflow(agent);
      const output = await workflow._promptStep(
        "structure",
        {
          prompt: "Return structured output",
          output: z.object({ answer: z.string() }),
          timeout: "1 minute",
          retries: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }
        },
        step,
        createEvent()
      );

      expect(output).toEqual({ answer: "fresh" });
      expect(submitCount).toBe(2);
      expect(cancelCalls).toEqual([
        {
          submissionId: "submission-1",
          reason: "Think workflow retrying prompt step"
        }
      ]);
    });

    it("falls back to resubmit after the recovery budget is exhausted (DO stays down)", async () => {
      // The DO never comes back during the recovery window. After exhausting
      // the bounded recovery rounds the loop cancels and resubmits.
      let submitCount = 0;
      let inspectCount = 0;
      const doNames: string[] = [];
      const cancelCalls: Array<{ submissionId: string; reason: string }> = [];

      const agent: FakeThinkAgent = {
        async submitMessages() {
          submitCount++;
          return createSubmissionResult(`submission-${submitCount}`, () => {});
        },
        async cancelSubmission(submissionId: string, reason: string) {
          cancelCalls.push({ submissionId, reason });
        },
        async inspectSubmission() {
          inspectCount++;
          throw new Error("DO is down");
        }
      };

      const step = {
        do: async (name: string, callback: () => Promise<unknown>) => {
          doNames.push(name);
          return callback();
        },
        waitForEvent: async (name: string) => {
          if (name === "structure:wait") {
            throw new Error("timed out");
          }
          return {
            payload: {
              submissionId: "submission-2",
              status: "completed",
              output: { answer: "fresh" }
            },
            [Symbol.dispose]: () => {}
          };
        },
        sleep: async () => {}
      } as unknown as AgentWorkflowStep;

      const workflow = createWorkflow(agent);
      const output = await workflow._promptStep(
        "structure",
        {
          prompt: "Return structured output",
          output: z.object({ answer: z.string() }),
          timeout: "1 minute",
          retries: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }
        },
        step,
        createEvent()
      );

      expect(output).toEqual({ answer: "fresh" });
      expect(submitCount).toBe(2);
      // Inspected once per recovery round before giving up (bounded budget).
      expect(inspectCount).toBe(5);
      expect(doNames).toContain("structure:recovery-check-0-4");
      expect(cancelCalls).toEqual([
        {
          submissionId: "submission-1",
          reason: "Think workflow retrying prompt step"
        }
      ]);
    });

    it("does not attempt recovery for non-timeout errors", async () => {
      let submitCount = 0;
      const doNames: string[] = [];
      const inspectCalls: string[] = [];

      const agent: FakeThinkAgent = {
        async submitMessages() {
          submitCount++;
          return createSubmissionResult(`submission-${submitCount}`, () => {});
        },
        async cancelSubmission() {},
        async inspectSubmission(submissionId: string) {
          inspectCalls.push(submissionId);
          return null;
        }
      };

      const step = {
        do: async (name: string, callback: () => Promise<unknown>) => {
          doNames.push(name);
          return callback();
        },
        waitForEvent: async () => {
          return {
            payload: {
              submissionId: `submission-${submitCount}`,
              status: submitCount < 2 ? "error" : "completed",
              error: submitCount < 2 ? "provider error" : undefined,
              output: submitCount < 2 ? undefined : { answer: "ok" }
            },
            [Symbol.dispose]: () => {}
          };
        },
        sleep: async () => {}
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

      expect(output).toEqual({ answer: "ok" });
      expect(submitCount).toBe(2);
      // inspectSubmission must NOT be called for non-timeout errors
      expect(inspectCalls).toEqual([]);
      expect(doNames).not.toContain("structure:recovery-check-0-0");
    });
  });
});
