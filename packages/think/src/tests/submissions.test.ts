import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { ThinkProgrammaticTestAgent } from "./agents/think-session";
import type {
  SubmitMessagesResult,
  ThinkSubmissionInspection,
  ThinkSubmissionStatus
} from "../think";

type ThinkSubmissionTestStub = {
  setDelayedChunkResponse(chunks: string[], delayMs: number): Promise<void>;
  clearDelayedChunkResponse(): Promise<void>;
  setInBandStreamErrorResponse(
    errorText: string,
    textChunks?: string[]
  ): Promise<void>;
  clearInBandStreamErrorResponse(): Promise<void>;
  setThrowingStreamError(message: string | null): Promise<void>;
  getProgrammaticStreamErrorCountForTest(): Promise<number>;
  getSubmissionFinalStatusForTest(
    resultStatus: "completed" | "error" | "skipped" | "aborted",
    streamError?: string
  ): Promise<ThinkSubmissionStatus>;
  runNonSubmissionStreamFailureForTest(requestId: string): Promise<void>;
  setSubmissionStatusDelayForTest(delayMs: number): Promise<void>;
  setProgrammaticResponseForTest(response: string): Promise<void>;
  setFinalAnswerResponseForTest(args: unknown): Promise<void>;
  persistAssistantMessageForTest(msg: UIMessage): Promise<void>;
  setLastBodyForTest(body: Record<string, unknown>): Promise<void>;
  setSubmissionRecoveryStaleMsForTest(ms: number): Promise<void>;
  setWorkflowEventFailuresForTest(count: number): Promise<void>;
  getWorkflowEventsForTest(): Promise<
    Array<{
      workflowName: string;
      workflowId: string;
      event: { type: string; payload?: unknown };
    }>
  >;
  testSubmitMessages(
    text: string,
    options?: {
      submissionId?: string;
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<SubmitMessagesResult>;
  testSubmitMessagesError(
    text: string,
    options?: {
      submissionId?: string;
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<string>;
  testSubmitMessagesEmptyError(): Promise<string>;
  inspectSubmissionForTest(
    submissionId: string
  ): Promise<ThinkSubmissionInspection | null>;
  listSubmissionsForTest(options?: {
    status?: ThinkSubmissionStatus | ThinkSubmissionStatus[];
    limit?: number;
  }): Promise<ThinkSubmissionInspection[]>;
  cancelSubmissionForTest(submissionId: string, reason?: string): Promise<void>;
  deleteSubmissionForTest(submissionId: string): Promise<boolean>;
  deleteSubmissionsForTest(options?: {
    status?: ThinkSubmissionStatus | ThinkSubmissionStatus[];
    completedBefore?: Date;
    limit?: number;
  }): Promise<number>;
  drainSubmissionsForTest(): Promise<void>;
  recoverSubmissionsForTest(): Promise<void>;
  resetTurnStateForTest(): Promise<void>;
  recoverChatFiberForTest(requestId: string): Promise<void>;
  continueRecoveredChatForTest(requestId: string): Promise<void>;
  continueRecoveredChatCatchingForTest(
    requestId: string
  ): Promise<string | null>;
  failNextRecoveredContinueForTest(message: string): Promise<void>;
  cancelDuringRecoveredContinuationForTest(
    requestId: string,
    delayMs: number
  ): Promise<void>;
  scheduleRecoveredContinuationForTest(requestId: string): Promise<void>;
  insertSubmissionForTest(options: {
    submissionId: string;
    status?: ThinkSubmissionStatus;
    requestId?: string;
    metadata?: Record<string, unknown>;
    errorMessage?: string | null;
    messagesAppliedAt?: number | null;
    completedAt?: number | null;
    createdAt?: number;
    messageIds?: string[];
  }): Promise<void>;
  insertMalformedSubmissionForTest(options: {
    submissionId: string;
    requestId?: string;
  }): Promise<void>;
  insertRecoverableFiberForTest(
    requestId: string,
    createdAt: number
  ): Promise<void>;
  recoverWorkflowNotificationsForTest(): Promise<void>;
  drainWorkflowNotificationsForTest(): Promise<void>;
  insertWorkflowNotificationForTest(options: {
    notificationId: string;
    submissionId: string;
    workflowName?: string;
    workflowId?: string;
    eventType?: string;
    payload?: unknown;
  }): Promise<void>;
  listWorkflowNotificationsForTest(): Promise<
    Array<{
      notificationId: string;
      submissionId: string;
      workflowName: string;
      workflowId: string;
      eventType: string;
      payloadJson: string;
      attempts: number;
      lastError: string | null;
      deliveredAt: number | null;
    }>
  >;
  getStoredMessages(): Promise<
    Array<{ id: string; role: string; parts?: unknown[] }>
  >;
  getResponseLog(): Promise<Array<{ status: string; requestId: string }>>;
  getSubmissionLog(): Promise<ThinkSubmissionInspection[]>;
};

async function freshAgent(
  name = crypto.randomUUID()
): Promise<ThinkSubmissionTestStub> {
  return getServerByName(
    env.ThinkProgrammaticTestAgent as unknown as DurableObjectNamespace<ThinkProgrammaticTestAgent>,
    name
  ) as unknown as Promise<ThinkSubmissionTestStub>;
}

const terminalStatuses = new Set<ThinkSubmissionStatus>([
  "completed",
  "aborted",
  "skipped",
  "error"
]);
const workflowPromptMetadataKey = "__thinkWorkflowPrompt";

async function waitForSubmission(
  agent: ThinkSubmissionTestStub,
  submissionId: string,
  predicate: (submission: ThinkSubmissionInspection) => boolean
): Promise<ThinkSubmissionInspection> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const submission = await agent.inspectSubmissionForTest(submissionId);
    if (submission && predicate(submission)) return submission;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const submission = await agent.inspectSubmissionForTest(submissionId);
  if (!submission) {
    throw new Error(`Submission ${submissionId} was not found`);
  }
  return submission;
}

async function waitForWorkflowEvent(
  agent: ThinkSubmissionTestStub,
  predicate: (
    event: Awaited<
      ReturnType<ThinkSubmissionTestStub["getWorkflowEventsForTest"]>
    >[number]
  ) => boolean
): Promise<
  Awaited<
    ReturnType<ThinkSubmissionTestStub["getWorkflowEventsForTest"]>
  >[number]
> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const event = (await agent.getWorkflowEventsForTest()).find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Workflow event was not delivered");
}

describe("Think durable submissions", () => {
  it("accepts a submission quickly and completes it through the normal turn path", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["slow ", "response"], 50);

    const accepted = await agent.testSubmitMessages("queued work", {
      submissionId: "sub-basic",
      idempotencyKey: "job-basic",
      metadata: { source: "test" }
    });

    expect(accepted).toMatchObject({
      accepted: true,
      submissionId: "sub-basic",
      requestId: "sub-basic",
      status: "pending",
      metadata: { source: "test" }
    });

    const completed = await waitForSubmission(
      agent,
      "sub-basic",
      (submission) => submission.status === "completed"
    );

    expect(completed.requestId).toBe("sub-basic");
    expect(completed.startedAt).toBeDefined();
    expect(completed.completedAt).toBeDefined();
    expect(await agent.getStoredMessages()).toHaveLength(2);

    const responses = await agent.getResponseLog();
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      requestId: "sub-basic",
      status: "completed"
    });

    const lifecycle = (await agent.getSubmissionLog()).map(
      (submission) => submission.status
    );
    expect(lifecycle).toContain("pending");
    expect(lifecycle).toContain("running");
    expect(lifecycle).toContain("completed");
  });

  it("deduplicates retries by idempotency key without appending duplicate messages", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["a", "b", "c"], 40);

    const first = await agent.testSubmitMessages("same job", {
      idempotencyKey: "external-job-1"
    });
    const retry = await agent.testSubmitMessages("same job", {
      idempotencyKey: "external-job-1"
    });

    expect(first.accepted).toBe(true);
    expect(retry.accepted).toBe(false);
    expect(retry.submissionId).toBe(first.submissionId);
    expect(retry.requestId).toBe(first.requestId);

    await waitForSubmission(agent, first.submissionId, (submission) =>
      terminalStatuses.has(submission.status)
    );

    const messages = await agent.getStoredMessages();
    expect(messages.filter((message) => message.role === "user")).toHaveLength(
      1
    );
  });

  it("deduplicates concurrent first submissions with the same idempotency key", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["slow"], 40);

    const results = await Promise.all([
      agent.testSubmitMessages("concurrent one", {
        idempotencyKey: "external-job-concurrent"
      }),
      agent.testSubmitMessages("concurrent two", {
        idempotencyKey: "external-job-concurrent"
      })
    ]);

    expect(results.map((result) => result.accepted).sort()).toEqual([
      false,
      true
    ]);
    expect(results[0].submissionId).toBe(results[1].submissionId);

    await waitForSubmission(agent, results[0].submissionId, (submission) =>
      terminalStatuses.has(submission.status)
    );
    const messages = await agent.getStoredMessages();
    expect(messages.filter((message) => message.role === "user")).toHaveLength(
      1
    );
  });

  it("awaits submission status hooks before returning acceptance", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["slow"], 50);
    await agent.setSubmissionStatusDelayForTest(25);

    const accepted = await agent.testSubmitMessages("hook wait", {
      submissionId: "sub-hook-wait"
    });

    expect(accepted.accepted).toBe(true);
    expect(
      (await agent.getSubmissionLog()).map((entry) => entry.status)
    ).toContain("pending");
  });

  it("deduplicates by submission id", async () => {
    const agent = await freshAgent();

    const first = await agent.testSubmitMessages("stable id", {
      submissionId: "sub-idempotent",
      idempotencyKey: "key-a"
    });
    const retry = await agent.testSubmitMessages("different payload ignored", {
      submissionId: "sub-idempotent",
      idempotencyKey: "key-a"
    });

    expect(retry.accepted).toBe(false);
    expect(retry.submissionId).toBe(first.submissionId);
  });

  it("rejects empty submissions before persistence", async () => {
    const agent = await freshAgent();

    await expect(agent.testSubmitMessagesEmptyError()).resolves.toBe(
      "submitMessages requires at least one message"
    );
    await expect(agent.listSubmissionsForTest()).resolves.toEqual([]);
  });

  it("rejects conflicting submission id and idempotency key pairs", async () => {
    const agent = await freshAgent();
    await agent.testSubmitMessages("original", {
      submissionId: "sub-conflict-original",
      idempotencyKey: "conflict-key"
    });

    await expect(
      agent.testSubmitMessagesError("conflict", {
        submissionId: "sub-conflict-other",
        idempotencyKey: "conflict-key"
      })
    ).resolves.toBe(
      "submissionId and idempotencyKey refer to different submissions"
    );
  });

  it("does not treat client body workflow-shaped data as workflow configuration", async () => {
    const agent = await freshAgent();
    await agent.setProgrammaticResponseForTest("plain text response");
    await agent.setLastBodyForTest({
      workflow: {
        name: "TEST_WORKFLOW",
        id: "client-controlled",
        stepName: "not-a-workflow-step",
        eventType: "think-prompt-client-body"
      },
      workflowPrompt: {
        output: {
          schema: {
            type: "object",
            properties: {
              title: { type: "string" }
            },
            required: ["title"],
            additionalProperties: false
          }
        },
        fingerprint: "client-body"
      }
    });

    const accepted = await agent.testSubmitMessages("normal body", {
      submissionId: "sub-client-body-workflow-shape"
    });
    const completed = await waitForSubmission(
      agent,
      accepted.submissionId,
      (submission) => terminalStatuses.has(submission.status)
    );

    expect(completed.status).toBe("completed");
    await expect(agent.getWorkflowEventsForTest()).resolves.toEqual([]);
  });

  it("does not treat public workflow-shaped metadata as workflow configuration", async () => {
    const agent = await freshAgent();
    await agent.setProgrammaticResponseForTest("plain text response");

    const accepted = await agent.testSubmitMessages("normal metadata", {
      submissionId: "sub-public-metadata-workflow-shape",
      metadata: {
        workflow: {
          name: "TEST_WORKFLOW",
          id: "metadata-controlled",
          stepName: "not-a-workflow-step",
          eventType: "think-prompt-metadata"
        },
        workflowPrompt: {
          output: {
            schema: {
              type: "object",
              properties: {
                title: { type: "string" }
              },
              required: ["title"],
              additionalProperties: false
            }
          },
          fingerprint: "metadata"
        }
      }
    });
    const completed = await waitForSubmission(
      agent,
      accepted.submissionId,
      (submission) => terminalStatuses.has(submission.status)
    );

    expect(completed.status).toBe("completed");
    await expect(agent.getWorkflowEventsForTest()).resolves.toEqual([]);
  });

  it("aborts a running submission without letting late completion overwrite it", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["a ", "b ", "c ", "d "], 50);

    const accepted = await agent.testSubmitMessages("cancel me", {
      submissionId: "sub-cancel"
    });

    await waitForSubmission(
      agent,
      accepted.submissionId,
      (submission) => submission.status === "running"
    );
    await agent.cancelSubmissionForTest(accepted.submissionId, "stop");

    const aborted = await waitForSubmission(
      agent,
      accepted.submissionId,
      (submission) => submission.status === "aborted"
    );

    expect(aborted.error).toBe("stop");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(
      agent.inspectSubmissionForTest(accepted.submissionId)
    ).resolves.toMatchObject({ status: "aborted" });
  });

  it("aborts a pending submission without running it", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-pending-cancel"
    });

    await agent.cancelSubmissionForTest("sub-pending-cancel", "not needed");
    await agent.drainSubmissionsForTest();

    await expect(
      agent.inspectSubmissionForTest("sub-pending-cancel")
    ).resolves.toMatchObject({
      status: "aborted",
      error: "not needed"
    });
    await expect(agent.getStoredMessages()).resolves.toHaveLength(0);
  });

  it("recovers terminal workflow submissions into workflow notifications", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-workflow-error",
      status: "error",
      completedAt: Date.now(),
      errorMessage: "model failed",
      metadata: {
        [workflowPromptMetadataKey]: {
          workflow: {
            name: "TEST_WORKFLOW",
            id: "workflow-recover",
            stepName: "draft-report",
            eventType: "think-prompt-recover"
          },
          output: { schema: { type: "object" } },
          fingerprint: "fingerprint"
        }
      }
    });

    await agent.recoverWorkflowNotificationsForTest();
    const notifications = await agent.listWorkflowNotificationsForTest();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      notificationId: "sub-workflow-error:think-prompt-recover",
      submissionId: "sub-workflow-error",
      workflowName: "TEST_WORKFLOW",
      workflowId: "workflow-recover",
      eventType: "think-prompt-recover",
      attempts: 0,
      payloadJson: "{}"
    });
    expect(notifications[0].deliveredAt).toBeTypeOf("number");
    await expect(agent.getWorkflowEventsForTest()).resolves.toEqual([
      {
        workflowName: "TEST_WORKFLOW",
        workflowId: "workflow-recover",
        event: {
          type: "think-prompt-recover",
          payload: {
            submissionId: "sub-workflow-error",
            status: "error",
            error: "model failed"
          }
        }
      }
    ]);
  });

  it("captures workflow structured output in terminal notifications", async () => {
    const agent = await freshAgent();
    // The structured workflow turn now terminates by calling the synthetic
    // `think_final_answer` tool; the mock model emits that call (issue #1685).
    await agent.setFinalAnswerResponseForTest({
      title: "Workflow output",
      labels: ["ops", "review"]
    });

    const accepted = await agent.testSubmitMessages("produce workflow output", {
      submissionId: "sub-workflow-output",
      metadata: {
        [workflowPromptMetadataKey]: {
          workflow: {
            name: "TEST_WORKFLOW",
            id: "workflow-output",
            stepName: "draft-report",
            eventType: "think-prompt-output"
          },
          output: {
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                labels: {
                  type: "array",
                  items: { type: "string" }
                }
              },
              required: ["title", "labels"],
              additionalProperties: false
            }
          },
          fingerprint: "fingerprint"
        }
      }
    });

    await waitForSubmission(
      agent,
      accepted.submissionId,
      (submission) => submission.status === "completed"
    );
    const event = await waitForWorkflowEvent(
      agent,
      (entry) => entry.event.type === "think-prompt-output"
    );

    expect(event).toEqual({
      workflowName: "TEST_WORKFLOW",
      workflowId: "workflow-output",
      event: {
        type: "think-prompt-output",
        payload: {
          submissionId: "sub-workflow-output",
          status: "completed",
          output: {
            title: "Workflow output",
            labels: ["ops", "review"]
          }
        }
      }
    });
  });

  it("does not persist the internal final-answer tool into the conversation", async () => {
    const agent = await freshAgent();
    await agent.setFinalAnswerResponseForTest({ title: "Hidden", labels: [] });

    const accepted = await agent.testSubmitMessages("structured, no noise", {
      submissionId: "sub-workflow-no-noise",
      metadata: {
        [workflowPromptMetadataKey]: {
          workflow: {
            name: "TEST_WORKFLOW",
            id: "workflow-no-noise",
            stepName: "draft",
            eventType: "think-prompt-no-noise"
          },
          output: {
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                labels: { type: "array", items: { type: "string" } }
              },
              required: ["title", "labels"],
              additionalProperties: false
            }
          },
          fingerprint: "fingerprint"
        }
      }
    });

    await waitForSubmission(
      agent,
      accepted.submissionId,
      (submission) => submission.status === "completed"
    );
    // The output is still delivered via the workflow event...
    const event = await waitForWorkflowEvent(
      agent,
      (entry) => entry.event.type === "think-prompt-no-noise"
    );
    expect((event.event.payload as { output?: unknown }).output).toEqual({
      title: "Hidden",
      labels: []
    });

    // ...but the synthetic `think_final_answer` tool call must not leak into the
    // stored conversation. The turn called only the internal tool, so no
    // assistant message should be persisted at all — just the user message.
    const stored = await agent.getStoredMessages();
    const toolParts = stored.flatMap((m) =>
      (m.parts ?? []).filter((p) => {
        const part = p as { type?: string; toolName?: string };
        return (
          part.type === "tool-think_final_answer" ||
          (part.type === "dynamic-tool" &&
            part.toolName === "think_final_answer")
        );
      })
    );
    expect(toolParts).toHaveLength(0);
    expect(stored.every((m) => m.role !== "assistant")).toBe(true);
  });

  it("strips the internal final-answer tool from a recovered assistant message", async () => {
    // The recovery re-persist path runs outside an active turn, so stripping
    // must be stateless (matched by the reserved tool name). Real content must
    // survive; the internal tool call/result must not.
    const agent = await freshAgent();
    await agent.persistAssistantMessageForTest({
      id: "asst-recovered",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "Here is the answer." },
        {
          type: "tool-think_final_answer",
          toolCallId: "call-1",
          state: "output-available",
          input: { word: "banana" },
          output: "Final answer recorded."
        }
      ]
    } as unknown as UIMessage);

    const stored = await agent.getStoredMessages();
    const recovered = stored.find((m) => m.id === "asst-recovered");
    expect(recovered).toBeTruthy();
    const partTypes = (recovered?.parts ?? []).map(
      (p) => (p as { type?: string }).type
    );
    expect(partTypes).toContain("text");
    expect(partTypes).not.toContain("tool-think_final_answer");
  });

  it("drains workflow notifications and clears delivered payloads", async () => {
    const agent = await freshAgent();
    await agent.insertWorkflowNotificationForTest({
      notificationId: "notification-deliver",
      submissionId: "sub-deliver",
      workflowName: "TEST_WORKFLOW",
      workflowId: "workflow-deliver",
      eventType: "think-prompt-deliver",
      payload: {
        submissionId: "sub-deliver",
        status: "completed",
        output: { title: "Done" }
      }
    });

    await agent.drainWorkflowNotificationsForTest();

    await expect(agent.getWorkflowEventsForTest()).resolves.toEqual([
      {
        workflowName: "TEST_WORKFLOW",
        workflowId: "workflow-deliver",
        event: {
          type: "think-prompt-deliver",
          payload: {
            submissionId: "sub-deliver",
            status: "completed",
            output: { title: "Done" }
          }
        }
      }
    ]);
    const notifications = await agent.listWorkflowNotificationsForTest();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      notificationId: "notification-deliver",
      attempts: 0,
      lastError: null,
      payloadJson: "{}"
    });
    expect(notifications[0].deliveredAt).toBeTypeOf("number");
  });

  it("keeps workflow notifications pending when delivery fails", async () => {
    const agent = await freshAgent();
    await agent.insertWorkflowNotificationForTest({
      notificationId: "notification-retry",
      submissionId: "sub-retry",
      workflowName: "TEST_WORKFLOW",
      workflowId: "workflow-retry",
      eventType: "think-prompt-retry"
    });
    await agent.setWorkflowEventFailuresForTest(1);

    await agent.drainWorkflowNotificationsForTest();

    const notifications = await agent.listWorkflowNotificationsForTest();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      notificationId: "notification-retry",
      attempts: 1,
      deliveredAt: null
    });
    expect(notifications[0].lastError).toContain(
      "simulated workflow event failure"
    );
    await expect(agent.getWorkflowEventsForTest()).resolves.toEqual([]);
  });

  it("runs durable pending rows through the scheduled drain callback path", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-scheduled-drain"
    });

    await agent.drainSubmissionsForTest();

    await expect(
      agent.inspectSubmissionForTest("sub-scheduled-drain")
    ).resolves.toMatchObject({
      status: "completed",
      requestId: "sub-scheduled-drain"
    });
    await expect(agent.getStoredMessages()).resolves.toHaveLength(2);
  });

  it("rewakes an existing pending submission on idempotent retry", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-retry-wakeup"
    });

    const retry = await agent.testSubmitMessages("retry wakeup", {
      submissionId: "sub-retry-wakeup"
    });

    expect(retry.accepted).toBe(false);
    await expect(
      waitForSubmission(
        agent,
        "sub-retry-wakeup",
        (submission) => submission.status === "completed"
      )
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("completes multiple submissions in FIFO order", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["done"], 30);

    const first = await agent.testSubmitMessages("first", {
      submissionId: "sub-fifo-1"
    });
    const second = await agent.testSubmitMessages("second", {
      submissionId: "sub-fifo-2"
    });

    await waitForSubmission(agent, first.submissionId, (submission) =>
      terminalStatuses.has(submission.status)
    );
    await waitForSubmission(agent, second.submissionId, (submission) =>
      terminalStatuses.has(submission.status)
    );

    const responses = await agent.getResponseLog();
    expect(responses.map((response) => response.requestId)).toEqual([
      "sub-fifo-1",
      "sub-fifo-2"
    ]);
  });

  it("marks pending submissions as skipped on turn reset", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-reset-skip"
    });

    await agent.resetTurnStateForTest();

    await expect(
      agent.inspectSubmissionForTest("sub-reset-skip")
    ).resolves.toMatchObject({
      status: "skipped"
    });
    await expect(agent.getStoredMessages()).resolves.toHaveLength(0);
  });

  it("requeues stale running submissions when messages were not applied", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-requeue",
      status: "running",
      messagesAppliedAt: null
    });

    await agent.recoverSubmissionsForTest();

    await expect(
      agent.inspectSubmissionForTest("sub-requeue")
    ).resolves.toMatchObject({
      status: "pending"
    });
  });

  it("drains pending submissions after a previous turn reset", async () => {
    const agent = await freshAgent();
    await agent.resetTurnStateForTest();
    await agent.insertSubmissionForTest({
      submissionId: "sub-after-reset"
    });

    await agent.drainSubmissionsForTest();

    await expect(
      agent.inspectSubmissionForTest("sub-after-reset")
    ).resolves.toMatchObject({
      status: "completed"
    });
  });

  it("marks stale running submissions with applied messages as error without replaying", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-applied-error",
      status: "running",
      messagesAppliedAt: Date.now()
    });

    await agent.recoverSubmissionsForTest();
    await agent.drainSubmissionsForTest();

    await expect(
      agent.inspectSubmissionForTest("sub-applied-error")
    ).resolves.toMatchObject({
      status: "error",
      error: "Submission was interrupted after messages were applied."
    });
    await expect(agent.getStoredMessages()).resolves.toHaveLength(0);
  });

  it("uses the subclass submission recovery stale window", async () => {
    const agent = await freshAgent();
    const now = Date.now();
    try {
      await agent.setSubmissionRecoveryStaleMsForTest(60 * 60 * 1000);
      await agent.insertSubmissionForTest({
        submissionId: "sub-custom-stale-window",
        requestId: "sub-custom-stale-window",
        status: "running",
        messagesAppliedAt: now,
        createdAt: now - 30 * 60 * 1000
      });
      await agent.insertRecoverableFiberForTest(
        "sub-custom-stale-window",
        now - 30 * 60 * 1000
      );

      await agent.recoverSubmissionsForTest();

      await expect(
        agent.inspectSubmissionForTest("sub-custom-stale-window")
      ).resolves.toMatchObject({
        status: "running"
      });
    } finally {
      await agent.setSubmissionRecoveryStaleMsForTest(15 * 60 * 1000);
    }
  });

  it("completes recovered chat fiber submissions through scheduled continuation", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-chat-recovery",
      requestId: "sub-chat-recovery",
      status: "running",
      messagesAppliedAt: Date.now()
    });

    await agent.recoverChatFiberForTest("sub-chat-recovery");

    const recovered = await waitForSubmission(
      agent,
      "sub-chat-recovery",
      (submission) => submission.status === "skipped"
    );
    expect(recovered).toMatchObject({
      status: "skipped"
    });
  });

  it("does not error running submissions while recovered continuation is scheduled", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-chat-recovery-scheduled",
      requestId: "sub-chat-recovery-scheduled",
      status: "running",
      messagesAppliedAt: Date.now()
    });
    await agent.scheduleRecoveredContinuationForTest(
      "sub-chat-recovery-scheduled"
    );

    await agent.recoverSubmissionsForTest();

    await expect(
      agent.inspectSubmissionForTest("sub-chat-recovery-scheduled")
    ).resolves.toMatchObject({
      status: "running"
    });
  });

  it("does not let recovered continuation overwrite a cancelled submission", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-chat-recovery-cancel",
      requestId: "sub-chat-recovery-cancel",
      status: "running",
      messagesAppliedAt: Date.now()
    });
    await agent.cancelSubmissionForTest("sub-chat-recovery-cancel", "stop");

    await agent.continueRecoveredChatForTest("sub-chat-recovery-cancel");

    await expect(
      agent.inspectSubmissionForTest("sub-chat-recovery-cancel")
    ).resolves.toMatchObject({
      status: "aborted",
      error: "stop"
    });
  });

  it("defers a recovered continuation on a platform transient and completes it on the re-run (#1730)", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["seed"], 1);
    const seed = await agent.testSubmitMessages("seed conversation", {
      submissionId: "sub-transient-defer-seed"
    });
    await waitForSubmission(
      agent,
      seed.submissionId,
      (submission) => submission.status === "completed"
    );

    await agent.setDelayedChunkResponse(["recovered ", "answer"], 1);
    await agent.insertSubmissionForTest({
      submissionId: "sub-transient-defer",
      requestId: "sub-transient-defer",
      status: "running",
      messagesAppliedAt: Date.now()
    });

    // First continuation lands in a deploy-reset window: storage throws the
    // `SqlError: SQL query failed: Network connection lost.` shape. The
    // callback must RE-THROW (so `Agent._executeScheduleCallback` preserves
    // the one-shot row for the platform to re-run) instead of terminalizing
    // through a give-up that needs the storage that's down.
    await agent.failNextRecoveredContinueForTest("Network connection lost.");
    await expect(
      agent.continueRecoveredChatCatchingForTest("sub-transient-defer")
    ).resolves.toMatch(/Network connection lost/);

    // The submission must STILL be running — marking it terminal on the defer
    // path would make the re-run skip with `submission_not_running` and the
    // turn would never resume (the self-defeating defer).
    await expect(
      agent.inspectSubmissionForTest("sub-transient-defer")
    ).resolves.toMatchObject({ status: "running" });

    // The deferred re-run (the preserved one-shot row firing on a healthy
    // isolate): the continuation streams normally and completes the
    // submission end-to-end.
    await agent.continueRecoveredChatForTest("sub-transient-defer");
    await expect(
      agent.inspectSubmissionForTest("sub-transient-defer")
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("preserves stream error text from recovered continuations", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["seed"], 1);
    const seed = await agent.testSubmitMessages("seed conversation", {
      submissionId: "sub-recovered-error-seed"
    });
    await waitForSubmission(
      agent,
      seed.submissionId,
      (submission) => submission.status === "completed"
    );

    await agent.setInBandStreamErrorResponse("recovered in-band failure");
    await agent.insertSubmissionForTest({
      submissionId: "sub-recovered-inband-error",
      requestId: "sub-recovered-inband-error",
      status: "running",
      messagesAppliedAt: Date.now()
    });

    await agent.continueRecoveredChatForTest("sub-recovered-inband-error");

    await expect(
      agent.inspectSubmissionForTest("sub-recovered-inband-error")
    ).resolves.toMatchObject({
      status: "error",
      error: "recovered in-band failure"
    });
  });

  it("aborts an active recovered continuation without a late overwrite", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["seed"], 1);
    const seed = await agent.testSubmitMessages("seed conversation", {
      submissionId: "sub-recovered-cancel-seed"
    });
    await waitForSubmission(
      agent,
      seed.submissionId,
      (submission) => submission.status === "completed"
    );

    await agent.setDelayedChunkResponse(["recover ", "turn"], 50);
    await agent.insertSubmissionForTest({
      submissionId: "sub-recovered-active-cancel",
      requestId: "sub-recovered-active-cancel",
      status: "running",
      messagesAppliedAt: Date.now()
    });

    await agent.cancelDuringRecoveredContinuationForTest(
      "sub-recovered-active-cancel",
      25
    );

    await expect(
      agent.inspectSubmissionForTest("sub-recovered-active-cancel")
    ).resolves.toMatchObject({
      status: "aborted"
    });
  });

  it("treats unmarked but already-applied submission messages as unsafe to replay", async () => {
    const agent = await freshAgent();
    const accepted = await agent.testSubmitMessages("already applied", {
      submissionId: "sub-applied-boundary"
    });
    await waitForSubmission(
      agent,
      accepted.submissionId,
      (submission) => submission.status === "completed"
    );
    const userMessage = (await agent.getStoredMessages()).find(
      (message) => message.role === "user"
    );
    expect(userMessage).toBeDefined();

    await agent.insertSubmissionForTest({
      submissionId: "sub-unmarked-applied",
      requestId: "sub-unmarked-applied",
      status: "running",
      messagesAppliedAt: null,
      messageIds: [userMessage!.id]
    });
    await agent.recoverSubmissionsForTest();

    await expect(
      agent.inspectSubmissionForTest("sub-unmarked-applied")
    ).resolves.toMatchObject({
      status: "error",
      error: "Submission was interrupted after messages were applied."
    });
  });

  it("marks malformed stored submission messages as error during recovery", async () => {
    const agent = await freshAgent();
    await agent.insertMalformedSubmissionForTest({
      submissionId: "sub-malformed-messages"
    });

    await agent.recoverSubmissionsForTest();

    const failed = await agent.inspectSubmissionForTest(
      "sub-malformed-messages"
    );
    expect(failed).toMatchObject({ status: "error" });
    expect(failed?.error).toBeTruthy();
  });

  it("stores error status and message when turn setup throws", async () => {
    const agent = await freshAgent();
    await agent.setThrowingStreamError("boom");

    const accepted = await agent.testSubmitMessages("explode", {
      submissionId: "sub-error"
    });

    const failed = await waitForSubmission(
      agent,
      accepted.submissionId,
      (submission) => submission.status === "error"
    );

    expect(failed.error).toBe("boom");
  });

  it("stores error status and message when an in-band stream error occurs", async () => {
    const agent = await freshAgent();
    await agent.setInBandStreamErrorResponse("submission in-band failure");

    const accepted = await agent.testSubmitMessages("in-band failure", {
      submissionId: "sub-inband-error"
    });

    const failed = await waitForSubmission(
      agent,
      accepted.submissionId,
      (submission) => submission.status === "error"
    );

    expect(failed.error).toBe("submission in-band failure");
  });

  it("does not retain stream error records for non-submission callers", async () => {
    const agent = await freshAgent();

    await agent.runNonSubmissionStreamFailureForTest(
      "non-submission-stream-failure"
    );

    await expect(agent.getProgrammaticStreamErrorCountForTest()).resolves.toBe(
      0
    );
  });

  it("does not let stream errors override aborted or skipped submission results", async () => {
    const agent = await freshAgent();

    await expect(
      agent.getSubmissionFinalStatusForTest("completed", "stream failed")
    ).resolves.toBe("error");
    await expect(
      agent.getSubmissionFinalStatusForTest("aborted", "abort surfaced")
    ).resolves.toBe("aborted");
    await expect(
      agent.getSubmissionFinalStatusForTest("skipped", "reset surfaced")
    ).resolves.toBe("skipped");
  });

  it("lists and deletes terminal submissions", async () => {
    const agent = await freshAgent();
    const accepted = await agent.testSubmitMessages("cleanup", {
      submissionId: "sub-cleanup"
    });

    await waitForSubmission(
      agent,
      accepted.submissionId,
      (submission) => submission.status === "completed"
    );

    const completed = await agent.listSubmissionsForTest({
      status: "completed"
    });
    expect(completed.map((submission) => submission.submissionId)).toContain(
      accepted.submissionId
    );

    await expect(
      agent.deleteSubmissionForTest(accepted.submissionId)
    ).resolves.toBe(true);
    await expect(
      agent.inspectSubmissionForTest(accepted.submissionId)
    ).resolves.toBeNull();
  });

  it("bulk deletes terminal submissions by status", async () => {
    const agent = await freshAgent();
    const first = await agent.testSubmitMessages("cleanup one");
    const second = await agent.testSubmitMessages("cleanup two");

    await waitForSubmission(agent, first.submissionId, (submission) =>
      terminalStatuses.has(submission.status)
    );
    await waitForSubmission(agent, second.submissionId, (submission) =>
      terminalStatuses.has(submission.status)
    );

    const deleted = await agent.deleteSubmissionsForTest({
      status: "completed",
      limit: 10
    });

    expect(deleted).toBe(2);
    await expect(
      agent.inspectSubmissionForTest(first.submissionId)
    ).resolves.toBeNull();
    await expect(
      agent.inspectSubmissionForTest(second.submissionId)
    ).resolves.toBeNull();
  });

  it("filters list and bulk delete before applying limits and cutoffs", async () => {
    const agent = await freshAgent();
    const now = Date.now();
    await agent.insertSubmissionForTest({
      submissionId: "sub-recent-pending",
      status: "pending",
      createdAt: now + 3_000
    });
    await agent.insertSubmissionForTest({
      submissionId: "sub-old-completed",
      status: "completed",
      createdAt: now,
      completedAt: now
    });
    await agent.insertSubmissionForTest({
      submissionId: "sub-new-completed",
      status: "completed",
      createdAt: now + 1_000,
      completedAt: now + 1_000
    });

    const completed = await agent.listSubmissionsForTest({
      status: "completed",
      limit: 1
    });
    expect(completed.map((submission) => submission.submissionId)).toEqual([
      "sub-new-completed"
    ]);

    await expect(
      agent.deleteSubmissionsForTest({
        status: "completed",
        completedBefore: new Date(now + 500),
        limit: 10
      })
    ).resolves.toBe(1);
    await expect(
      agent.inspectSubmissionForTest("sub-old-completed")
    ).resolves.toBeNull();
    await expect(
      agent.inspectSubmissionForTest("sub-new-completed")
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("applies list limits across multiple statuses after sorting", async () => {
    const agent = await freshAgent();
    const now = Date.now();
    await agent.insertSubmissionForTest({
      submissionId: "sub-multi-old-completed",
      status: "completed",
      createdAt: now,
      completedAt: now
    });
    await agent.insertSubmissionForTest({
      submissionId: "sub-multi-new-pending",
      status: "pending",
      createdAt: now + 3_000
    });
    await agent.insertSubmissionForTest({
      submissionId: "sub-multi-mid-completed",
      status: "completed",
      createdAt: now + 2_000,
      completedAt: now + 2_000
    });

    const submissions = await agent.listSubmissionsForTest({
      status: ["pending", "completed"],
      limit: 2
    });

    expect(submissions.map((submission) => submission.submissionId)).toEqual([
      "sub-multi-new-pending",
      "sub-multi-mid-completed"
    ]);
  });

  it("bulk delete skips active submissions even when explicitly requested", async () => {
    const agent = await freshAgent();
    const now = Date.now();
    await agent.insertSubmissionForTest({
      submissionId: "sub-delete-active-pending",
      status: "pending",
      createdAt: now
    });
    await agent.insertSubmissionForTest({
      submissionId: "sub-delete-active-running",
      status: "running",
      createdAt: now + 1
    });
    await agent.insertSubmissionForTest({
      submissionId: "sub-delete-active-completed",
      status: "completed",
      createdAt: now + 2,
      completedAt: now + 2
    });

    await expect(
      agent.deleteSubmissionsForTest({
        status: ["pending", "running", "completed"],
        limit: 10
      })
    ).resolves.toBe(1);
    await expect(
      agent.inspectSubmissionForTest("sub-delete-active-pending")
    ).resolves.toMatchObject({ status: "pending" });
    await expect(
      agent.inspectSubmissionForTest("sub-delete-active-running")
    ).resolves.toMatchObject({ status: "running" });
    await expect(
      agent.inspectSubmissionForTest("sub-delete-active-completed")
    ).resolves.toBeNull();
  });

  it("does not delete pending or missing submissions", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-delete-pending",
      status: "pending"
    });

    await expect(
      agent.deleteSubmissionForTest("sub-delete-pending")
    ).resolves.toBe(false);
    await expect(
      agent.deleteSubmissionForTest("sub-delete-missing")
    ).resolves.toBe(false);
  });
});
