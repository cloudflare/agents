import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { ThinkProgrammaticTestAgent } from "./agents/think-session";
import type {
  SubmitMessagesResult,
  ThinkSubmissionInspection,
  ThinkSubmissionStatus
} from "../think";

type ThinkSubmissionTestStub = {
  setDelayedChunkResponse(chunks: string[], delayMs: number): Promise<void>;
  clearDelayedChunkResponse(): Promise<void>;
  setThrowingStreamError(message: string | null): Promise<void>;
  getProgrammaticStreamErrorCountForTest(): Promise<number>;
  getSubmissionFinalStatusForTest(
    resultStatus: "completed" | "skipped" | "aborted",
    streamError?: string
  ): Promise<ThinkSubmissionStatus>;
  runNonSubmissionStreamFailureForTest(requestId: string): Promise<void>;
  setSubmissionStatusDelayForTest(delayMs: number): Promise<void>;
  setSubmissionRecoveryStaleMsForTest(ms: number): Promise<void>;
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
  cancelDuringRecoveredContinuationForTest(
    requestId: string,
    delayMs: number
  ): Promise<void>;
  scheduleRecoveredContinuationForTest(requestId: string): Promise<void>;
  insertSubmissionForTest(options: {
    submissionId: string;
    status?: ThinkSubmissionStatus;
    requestId?: string;
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
