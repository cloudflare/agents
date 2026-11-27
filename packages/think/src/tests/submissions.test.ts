import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { UIMessage } from "ai";
import type { ThinkProgrammaticTestAgent } from "./agents/think-session";
import type {
  CancelSubmissionResult,
  SubmitMessagesResult,
  ThinkSubmissionInspection,
  ThinkSubmissionStatus
} from "../think";

type ThinkSubmissionTestStub = {
  holdRecoveryOnceForTest(): Promise<void>;
  answerRecoveryForTest(answer: {
    continue?: boolean;
    persist?: boolean;
  }): Promise<void>;
  recoveryHeldForTest(): Promise<boolean>;
  holdChunksAfterResetForTest(
    chunks: string[],
    delayMs: number,
    after: number
  ): Promise<void>;
  resetIsolateForTest(): Promise<void>;
  setDelayedChunkResponse(chunks: string[], delayMs: number): Promise<void>;
  holdChunksAfterForTest(after: number): Promise<void>;
  isChunkStreamHeldForTest(): Promise<boolean>;
  setStallTimeoutForTest(timeoutMs: number): Promise<void>;
  failInBandAfterResetForTest(errorText: string): Promise<void>;
  abandonChunkHoldForTest(): Promise<void>;
  releaseChunksForTest(): Promise<void>;
  clearDelayedChunkResponse(): Promise<void>;
  setInBandStreamErrorResponse(
    errorText: string,
    textChunks?: string[]
  ): Promise<void>;
  clearInBandStreamErrorResponse(): Promise<void>;
  setThrowingStreamError(message: string | null): Promise<void>;
  getProgrammaticStreamErrorCountForTest(): Promise<number>;
  notifyDetachedFinishForTest(options?: {
    runId?: string;
    notifySource?: string;
  }): Promise<void>;
  notifyDetachedMilestoneForTest(options?: {
    runId?: string;
    name?: string;
    notifySource?: string;
    times?: number;
    mode?: "react" | "narrate";
  }): Promise<void>;
  serializedDetachedDeliveryOrderingForTest(): Promise<string[]>;
  waitFromWorkATurnLeftRunningForTest(): Promise<string>;
  runNestedAdmissionScenario(
    mode: "detachedNotify" | "submitThenWait"
  ): Promise<{
    attempted: boolean;
    succeeded: boolean;
    error: string | null;
  }>;
  waitInSubmissionStatusHookForTest(): Promise<void>;
  getSubmissionStatusHookWaitsForTest(): Promise<string[]>;
  testRunTurnWait(options: {
    continuation?: boolean;
    channel?: string;
  }): Promise<{ status: string }>;
  getCapturedOptions(): Promise<
    Array<{ continuation?: boolean; channel?: string }>
  >;
  getSubmissionFinalStatusForTest(
    resultStatus: "completed" | "error" | "skipped" | "aborted",
    streamError?: string
  ): Promise<ThinkSubmissionStatus>;
  runNonSubmissionStreamFailureForTest(requestId: string): Promise<void>;
  setSubmissionStatusDelayForTest(delayMs: number): Promise<void>;
  holdSubmissionStatusHookForTest(
    status?: ThinkSubmissionInspection["status"]
  ): Promise<void>;
  hookCancelResultForTest(): Promise<unknown>;
  waitFromHeldHookForTest(submissionId: string): Promise<string>;
  cancelInSubmissionStatusHookForTest(): Promise<void>;
  waitForIdleForTest(): Promise<void>;
  isTasksIdleForTest(): Promise<boolean>;
  isSubmissionStatusHookHeldForTest(): Promise<boolean>;
  statusReportsQueuedForTest(submissionId: string): Promise<number>;
  releaseSubmissionStatusHookForTest(): Promise<void>;
  setProgrammaticResponseForTest(response: string): Promise<void>;
  useRecoveryToolModelForTest(options?: {
    resetAfterTool?: boolean;
  }): Promise<void>;
  getRecoveryToolExecutionsForTest(): Promise<number>;
  getMessagesForTest(): Promise<UIMessage[]>;
  setFinalAnswerResponseForTest(args: unknown): Promise<void>;
  persistAssistantMessageForTest(msg: UIMessage): Promise<void>;
  setLastBodyForTest(body: Record<string, unknown>): Promise<void>;
  setSubmissionRecoveryStaleMsForTest(ms: number): Promise<void>;
  keepSubmissionRecoveryStaleMsForTest(ms: number): Promise<void>;
  setWorkflowEventFailuresForTest(count: number): Promise<void>;
  repeatSubmissionReportForTest(submissionId: string): Promise<void>;
  getErrorsForTest(): Promise<string[]>;
  getWorkflowEventsForTest(): Promise<
    Array<{
      workflowName: string;
      workflowId: string;
      event: { type: string; payload?: unknown };
    }>
  >;
  probeSubmissionAlarmOwnershipForTest(): Promise<{
    readonly alarmDrainCalls: number;
    readonly inlineDrainCalls: number;
    readonly submission: SubmitMessagesResult;
  }>;
  testSubmitMessages(
    text: string,
    options?: {
      submissionId?: string;
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<SubmitMessagesResult>;
  cancelQueuedRunningSubmissionBeforeSlotForTest(options?: {
    submissionId?: string;
    metadata?: Record<string, unknown>;
    messageTexts?: string[];
    channel?: string;
  }): Promise<{
    submission: ThinkSubmissionInspection | null;
    messages: Array<{ id: string; role: string; parts?: unknown[] }>;
    responses: Array<{ status: string; requestId: string }>;
    submissionLog: ThinkSubmissionInspection[];
    workflowEvents: Array<{
      workflowName: string;
      workflowId: string;
      event: { type: string; payload?: unknown };
    }>;
  }>;
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
  submissionResultForTest(submissionId: string): Promise<unknown>;
  keepAliveHoldsForTest(): Promise<number>;
  recordLargeTurnOutputForTest(
    submissionId: string,
    outputChars: number,
    metadataChars?: number
  ): Promise<{ resultStatus?: string; hasOutput: boolean }>;
  parkSubmissionForTest(
    submissionId: string,
    progress: Record<string, unknown>
  ): Promise<void>;
  cancelSubmissionForTest(
    submissionId: string,
    reason?: string
  ): Promise<CancelSubmissionResult>;
  waitForSubmissionForTest(
    submissionId: string,
    options?: { timeoutMs?: number }
  ): Promise<ThinkSubmissionInspection | null>;
  deleteSubmissionForTest(submissionId: string): Promise<boolean>;
  markSubmissionRunningHereForTest(submissionId: string): Promise<void>;
  setSubmissionRowStatusForTest(
    submissionId: string,
    status: ThinkSubmissionStatus
  ): Promise<void>;
  deleteSubmissionsForTest(options?: {
    status?: ThinkSubmissionStatus | ThinkSubmissionStatus[];
    completedBefore?: Date;
    limit?: number;
  }): Promise<number>;
  drainSubmissionsForTest(): Promise<void>;
  seedLegacySubmissionTableForTest(
    rows: Array<{
      submissionId: string;
      status: ThinkSubmissionStatus;
      idempotencyKey?: string;
      text?: string;
      messagesJson?: string;
      createdAt: number;
      startedAt?: number | null;
      completedAt?: number | null;
      errorMessage?: string | null;
      messageId?: string | null;
      metadataJson?: string;
      outputJson?: string;
    }>
  ): Promise<void>;
  getLegacySubmissionAtStartForTest(): Promise<string | null>;
  hasLegacySubmissionTableForTest(): Promise<boolean>;
  recoverSubmissionsForTest(): Promise<void>;
  abortSubmissionRequestForTest(requestId: string): Promise<void>;
  recoverSubmissionSettlementForTest(requestId: string): Promise<void>;
  useLegacySubmissionSchemaForTest(): Promise<void>;
  seedSubmissionStreamForTest(
    requestId: string,
    status: "completed" | "error" | "retry"
  ): Promise<void>;
  moveSubmissionRequestForTest(
    submissionId: string,
    requestId: string
  ): Promise<void>;
  resetTurnStateForTest(): Promise<void>;
  recoverChatFiberForTest(requestId: string): Promise<void>;
  persistOrphanedStreamForTest(
    requestId: string,
    messageId: string
  ): Promise<void>;
  persistContinuationOrphanForTest(
    requestId: string,
    leafId: string,
    times: number,
    options?: {
      startMessageId?: string;
      leafMetadata?: Record<string, unknown>;
      startMetadata?: Record<string, unknown>;
      leafParts?: unknown[];
      chunks?: Array<Record<string, unknown>>;
      deleteLeaf?: boolean;
    }
  ): Promise<void>;
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
  scheduleRecoveredRetryForTest(
    requestId: string,
    transport: "tasks" | "legacy-schedule"
  ): Promise<void>;
  markScheduledRecoveryTaskTerminalForTest(requestId: string): Promise<void>;
  runScheduledRecoveryRetryForTest(): Promise<void>;
  runScheduledRecoveryContinueForTest(): Promise<void>;
  persistTestMessage(msg: UIMessage): Promise<void>;
  interruptChatTurnForTest(input: {
    requestId: string;
    latestMessageId: string;
    latestMessageRole: "user" | "assistant";
    latestUserMessageId: string;
    chunks: Array<Record<string, unknown>>;
  }): Promise<{ scheduledContinueCount: number; scheduledRetryCount: number }>;
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
  drainWorkflowNotificationsForTest(): Promise<void>;
  insertWorkflowNotificationForTest(options: {
    notificationId: string;
    submissionId: string;
    workflowName?: string;
    workflowId?: string;
    eventType?: string;
    payload?: unknown;
    firstFailedAt?: number;
  }): Promise<void>;
  listWorkflowNotificationsForTest(): Promise<
    Array<{
      notificationId: string;
      workflowName: string;
      workflowId: string;
      eventType: string;
      payload: unknown;
    }>
  >;
  getStoredMessages(): Promise<
    Array<{
      id: string;
      role: string;
      parts?: unknown[];
      metadata?: unknown;
    }>
  >;
  getResponseLog(): Promise<Array<{ status: string; requestId: string }>>;
  getSubmissionLog(): Promise<ThinkSubmissionInspection[]>;
  inspectSubmissionStreamEvidenceForTest(requestId: string): Promise<{
    streamStatus: string | null;
    resultStatus: string | null;
    hasActiveStream: boolean;
    hasActiveRequestStream: boolean;
    resumeFrames: Array<{ type: string; reason?: string }>;
  }>;
};

async function freshAgent(
  name = crypto.randomUUID()
): Promise<ThinkSubmissionTestStub> {
  return getAgentByName(
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

/** Wait until the held delayed-chunk stream has sent its chunks. */
async function chunkStreamHeld(agent: ThinkSubmissionTestStub): Promise<void> {
  await vi.waitFor(
    async () => expect(await agent.isChunkStreamHeldForTest()).toBe(true),
    { timeout: 5000, interval: 10 }
  );
}

/**
 * Wait until no Tasks run is open: every turn, recovery and status report
 * has ended. Holds on the harness-backed Think as well, which has no turn
 * queue to wait on.
 */
async function tasksIdle(agent: ThinkSubmissionTestStub): Promise<void> {
  await vi.waitFor(
    async () => expect(await agent.isTasksIdleForTest()).toBe(true),
    { timeout: 10_000, interval: 20 }
  );
}

/** Wait until the held `onSubmissionStatus` call is running. */
async function statusHookHeld(agent: ThinkSubmissionTestStub): Promise<void> {
  await vi.waitFor(
    async () =>
      expect(await agent.isSubmissionStatusHookHeldForTest()).toBe(true),
    { timeout: 5000, interval: 10 }
  );
}

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

async function waitForSubmissionByKey(
  agent: ThinkSubmissionTestStub,
  idempotencyKey: string,
  predicate: (submission: ThinkSubmissionInspection) => boolean
): Promise<ThinkSubmissionInspection> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const submission = (await agent.listSubmissionsForTest({ limit: 20 })).find(
      (item) => item.idempotencyKey === idempotencyKey
    );
    if (submission && predicate(submission)) return submission;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const submission = (await agent.listSubmissionsForTest({ limit: 20 })).find(
    (item) => item.idempotencyKey === idempotencyKey
  );
  if (!submission) {
    throw new Error(`Submission with key ${idempotencyKey} was not found`);
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

function textParts(messages: Array<{ parts?: unknown[] }>): string[] {
  return messages.flatMap((message) =>
    (message.parts ?? []).flatMap((part) => {
      if (
        part !== null &&
        typeof part === "object" &&
        "type" in part &&
        "text" in part &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        return [part.text];
      }
      return [];
    })
  );
}

describe("Think durable submissions", () => {
  it("runs accepted submissions only from the scheduled alarm invocation", async () => {
    const agent = await freshAgent();

    const probe = await agent.probeSubmissionAlarmOwnershipForTest();

    expect(probe.inlineDrainCalls).toBe(0);
    expect(probe.alarmDrainCalls).toBe(1);
    expect(probe.submission).toMatchObject({
      accepted: true,
      status: "pending"
    });
    await waitForSubmission(
      agent,
      probe.submission.submissionId,
      (submission) => submission.status === "completed"
    );
  });

  it("never marks a live turn stale, however long it runs past the stale window (#2498)", async () => {
    const agent = await freshAgent();
    // The window only judges an interrupted turn's recovery evidence; a
    // turn whose isolate lives holds its run and is never reconciled.
    await agent.setSubmissionRecoveryStaleMsForTest(50);
    try {
      await agent.setDelayedChunkResponse(["a", "b", "c", "d"], 300);
      await agent.testSubmitMessages("a long turn", {
        submissionId: "sub-long-live"
      });
      const done = await agent.waitForSubmissionForTest("sub-long-live", {
        timeoutMs: 10_000
      });
      expect(done?.status).toBe("completed");
      expect(done!.completedAt! - done!.startedAt!).toBeGreaterThan(1_000);
    } finally {
      await agent.setSubmissionRecoveryStaleMsForTest(15 * 60 * 1000);
    }
  });

  it("takes no keep-alive hold when it starts with no stored requests to replay", async () => {
    const agent = await freshAgent();
    await expect(agent.keepAliveHoldsForTest()).resolves.toBe(0);
  });

  it("ignores an app's own __cf_progress field and still records the turn's progress", async () => {
    const agent = await freshAgent();
    await agent.testSubmitMessages("with a clashing field", {
      submissionId: "sub-progress-clash",
      metadata: { __cf_progress: "draft", source: "app" }
    });
    const done = await agent.waitForSubmissionForTest("sub-progress-clash", {
      timeoutMs: 10_000
    });
    expect(done).toMatchObject({
      status: "completed",
      metadata: { source: "app" }
    });
    expect(done?.messageId).toBeDefined();
  });

  it("refuses metadata that leaves no room for the turn's progress, and keeps the progress of metadata that fits", async () => {
    const agent = await freshAgent();
    await expect(
      agent.testSubmitMessagesError("too much metadata", {
        submissionId: "sub-meta-full",
        metadata: { big: "m".repeat(1_850_000) }
      })
    ).resolves.toMatch(/fit beside the submission's progress/);
    await agent.testSubmitMessages("metadata that fits", {
      submissionId: "sub-meta-fits",
      metadata: { big: "m".repeat(1_700_000) }
    });
    const done = await agent.waitForSubmissionForTest("sub-meta-fits", {
      timeoutMs: 10_000
    });
    expect(done?.status).toBe("completed");
    expect(done?.messageId).toBeDefined();
  });

  // With a submission that is really running (its reply held), not a row
  // written as `running`: the successors of the tests below that seed one.
  describe("while a submission runs", () => {
    /** A submission whose reply waits after its first chunk. */
    async function running(agent: ThinkSubmissionTestStub, id: string) {
      await agent.setDelayedChunkResponse(["a ", "b ", "c "], 50);
      await agent.holdChunksAfterForTest(1);
      onTestFinished(() => agent.releaseChunksForTest());
      await agent.testSubmitMessages(`run ${id}`, { submissionId: id });
      await chunkStreamHeld(agent);
    }

    it("lists it as running, and the one that waits behind it as pending", async () => {
      const agent = await freshAgent();
      await running(agent, "sub-really-running");
      await agent.testSubmitMessages("wait behind it", {
        submissionId: "sub-really-queued"
      });

      await expect(
        agent.listSubmissionsForTest({ status: "running", limit: 1 })
      ).resolves.toMatchObject([{ submissionId: "sub-really-running" }]);
      await expect(
        agent.listSubmissionsForTest({ status: "pending", limit: 1 })
      ).resolves.toMatchObject([{ submissionId: "sub-really-queued" }]);
    });

    it("a bulk delete that asks for every status deletes only the finished one", async () => {
      const agent = await freshAgent();
      await agent.testSubmitMessages("finish first", {
        submissionId: "sub-bulk-completed"
      });
      await expect(
        agent.waitForSubmissionForTest("sub-bulk-completed", {
          timeoutMs: 10_000
        })
      ).resolves.toMatchObject({ status: "completed" });
      await running(agent, "sub-bulk-running");
      await agent.testSubmitMessages("wait behind it", {
        submissionId: "sub-bulk-pending"
      });

      await expect(
        agent.deleteSubmissionsForTest({
          status: ["pending", "running", "completed"],
          limit: 10
        })
      ).resolves.toBe(1);
      await expect(
        agent.inspectSubmissionForTest("sub-bulk-completed")
      ).resolves.toBeNull();
      await expect(
        agent.inspectSubmissionForTest("sub-bulk-running")
      ).resolves.toMatchObject({ status: "running" });
      await expect(
        agent.inspectSubmissionForTest("sub-bulk-pending")
      ).resolves.toMatchObject({ status: "pending" });
    });

    /** A submission that has completed, and when. */
    async function completed(agent: ThinkSubmissionTestStub, id: string) {
      await agent.testSubmitMessages(`finish ${id}`, { submissionId: id });
      await expect(
        agent.waitForSubmissionForTest(id, { timeoutMs: 10_000 })
      ).resolves.toMatchObject({ status: "completed" });
      const done = await agent.inspectSubmissionForTest(id);
      // The next one completes at a later millisecond.
      await vi.waitFor(() =>
        expect(Date.now()).toBeGreaterThan(done?.completedAt ?? 0)
      );
      return done?.completedAt ?? 0;
    }

    it("a status filter applies before the limit and the cutoff, to list and to delete", async () => {
      const agent = await freshAgent();
      await completed(agent, "sub-older-completed");
      const newer = await completed(agent, "sub-newer-completed");
      await running(agent, "sub-filter-running");
      await agent.testSubmitMessages("wait behind it", {
        submissionId: "sub-filter-pending"
      });

      // The newest completed one, though two newer submissions exist.
      const listed = await agent.listSubmissionsForTest({
        status: "completed",
        limit: 1
      });
      expect(listed.map((submission) => submission.submissionId)).toEqual([
        "sub-newer-completed"
      ]);
      await expect(
        agent.deleteSubmissionsForTest({
          status: "completed",
          completedBefore: new Date(newer),
          limit: 10
        })
      ).resolves.toBe(1);
      await expect(
        agent.inspectSubmissionForTest("sub-older-completed")
      ).resolves.toBeNull();
      await expect(
        agent.inspectSubmissionForTest("sub-newer-completed")
      ).resolves.toMatchObject({ status: "completed" });
    });

    it("a limit over several statuses takes the newest of them all", async () => {
      const agent = await freshAgent();
      await completed(agent, "sub-several-older");
      await completed(agent, "sub-several-newer");
      await running(agent, "sub-several-running");
      await agent.testSubmitMessages("wait behind it", {
        submissionId: "sub-several-pending"
      });

      const listed = await agent.listSubmissionsForTest({
        status: ["pending", "completed"],
        limit: 2
      });
      expect(listed.map((submission) => submission.submissionId)).toEqual([
        "sub-several-pending",
        "sub-several-newer"
      ]);
    });

    it("a turn reset ends it skipped, and the one that waits behind it", async () => {
      const agent = await freshAgent();
      await running(agent, "sub-reset-running");
      await agent.testSubmitMessages("wait behind it", {
        submissionId: "sub-reset-queued"
      });

      await agent.resetTurnStateForTest();

      for (const id of ["sub-reset-running", "sub-reset-queued"]) {
        await expect(
          agent.waitForSubmissionForTest(id, { timeoutMs: 10_000 })
        ).resolves.toMatchObject({
          status: "skipped",
          error: "Submission was skipped by turn reset."
        });
      }
      // A filter for skipped finds them, to list and to delete.
      const listed = await agent.listSubmissionsForTest({ status: "skipped" });
      expect(
        listed.map((submission) => submission.submissionId).sort()
      ).toEqual(["sub-reset-queued", "sub-reset-running"]);
      await expect(
        agent.deleteSubmissionsForTest({ status: "skipped" })
      ).resolves.toBe(2);
      await expect(
        agent.listSubmissionsForTest({ status: "skipped" })
      ).resolves.toEqual([]);
    });

    it("a cancel says its messages were applied", async () => {
      const agent = await freshAgent();
      await running(agent, "sub-really-applied");

      await expect(
        agent.cancelSubmissionForTest("sub-really-applied")
      ).resolves.toMatchObject({
        outcome: "cancelled",
        previousStatus: "running",
        messagesApplied: true
      });
    });
  });

  // Through a real eviction, as an app sees it: the successors of the tests
  // below that seed a `running` row with the class's own recovery facts.
  describe("a submission whose isolate is evicted while it runs", () => {
    /** Submit, hold the reply after its first chunk, and evict. */
    async function evictedMidReply(submissionId: string) {
      const name = crypto.randomUUID();
      const agent = await freshAgent(name);
      await agent.setDelayedChunkResponse(["a ", "b ", "c ", "d "], 50);
      await agent.holdChunksAfterForTest(1);
      await agent.testSubmitMessages("interrupt me", { submissionId });
      await chunkStreamHeld(agent);
      await agent.resetIsolateForTest().catch(() => {});
      return freshAgent(name);
    }

    it("finishes it once: one question, one reply, and the submission completed", async () => {
      const restarted = await evictedMidReply("sub-evicted");

      const done = await restarted.waitForSubmissionForTest("sub-evicted", {
        timeoutMs: 20_000
      });
      expect(done).toMatchObject({ status: "completed" });
      const stored = await restarted.getStoredMessages();
      expect(stored.map((message) => message.role)).toEqual([
        "user",
        "assistant"
      ]);
      // The submission names the reply it ended with.
      expect(done?.messageId).toBe(stored[1].id);
      // And it is terminal for good: nothing runs it again.
      await tasksIdle(restarted);
      expect(
        (await restarted.getStoredMessages()).map((message) => message.role)
      ).toEqual(["user", "assistant"]);
    }, 30_000);

    it("is never reported as failed while its reply is being recovered", async () => {
      const name = crypto.randomUUID();
      const agent = await freshAgent(name);
      await agent.setDelayedChunkResponse(["a ", "b ", "c ", "d "], 50);
      await agent.holdChunksAfterForTest(1);
      await agent.testSubmitMessages("interrupt me", {
        submissionId: "sub-evicted-running"
      });
      await chunkStreamHeld(agent);
      await agent.holdChunksAfterResetForTest(["e ", "f ", "g "], 50, 1);
      await agent.resetIsolateForTest().catch(() => {});
      const restarted = await freshAgent(name);
      onTestFinished(() => restarted.releaseChunksForTest());
      // The recovered reply is streaming, and waits.
      await chunkStreamHeld(restarted);

      await expect(
        restarted.inspectSubmissionForTest("sub-evicted-running")
      ).resolves.toMatchObject({ status: "running" });
      await restarted.releaseChunksForTest();
      await expect(
        restarted.waitForSubmissionForTest("sub-evicted-running", {
          timeoutMs: 20_000
        })
      ).resolves.toMatchObject({ status: "completed" });
      // Its status went to `completed` and nowhere else since the reset.
      const reported = (await restarted.getSubmissionLog())
        .filter((entry) => entry.submissionId === "sub-evicted-running")
        .map((entry) => entry.status);
      expect(reported).not.toContain("error");
      expect(reported).not.toContain("aborted");
      expect(reported.at(-1)).toBe("completed");
    }, 30_000);

    it("keeps a tool's result and does not run the tool again", async () => {
      const name = crypto.randomUUID();
      const agent = await freshAgent(name);
      // The isolate resets as the model is asked again with the result.
      await agent.useRecoveryToolModelForTest({ resetAfterTool: true });
      await agent.testSubmitMessages("run the tool", {
        submissionId: "sub-evicted-tool"
      });

      // Whichever isolate answers: the reset may still be under way.
      const done = await vi.waitFor(
        async () => {
          const submission = await (
            await freshAgent(name)
          ).inspectSubmissionForTest("sub-evicted-tool");
          expect(submission).toMatchObject({ status: "completed" });
          return submission;
        },
        { timeout: 20_000, interval: 50 }
      );
      const restarted = await freshAgent(name);
      expect(await restarted.getRecoveryToolExecutionsForTest()).toBe(1);
      const stored = await restarted.getStoredMessages();
      expect(stored.map((message) => message.role)).toEqual([
        "user",
        "assistant"
      ]);
      // One reply: the tool's call with its result, then the text that
      // followed the reset.
      const parts = stored[1].parts as Array<{
        type: string;
        state?: string;
        text?: string;
      }>;
      expect(
        parts.filter((part) => part.type.startsWith("tool-"))
      ).toMatchObject([{ state: "output-available", output: "echo: hello" }]);
      expect(
        parts.some(
          (part) => part.type === "text" && part.text === "Done with tools"
        )
      ).toBe(true);
      expect(done?.messageId).toBe(stored[1].id);
    }, 30_000);

    // Successor of think-session's "leaves the recovered submission
    // `running` on a deferral so the re-run picks it up": the platform cuts
    // the recovery attempt (a reset while onChatRecovery runs).
    it("stays running when a reset also cuts its recovery, then completes once", async () => {
      const name = crypto.randomUUID();
      const agent = await freshAgent(name);
      await agent.holdRecoveryOnceForTest();
      await agent.setDelayedChunkResponse(["a ", "b ", "c ", "d "], 50);
      await agent.holdChunksAfterForTest(1);
      await agent.testSubmitMessages("interrupt me twice", {
        submissionId: "sub-cut-twice"
      });
      await chunkStreamHeld(agent);
      await agent.resetIsolateForTest().catch(() => {});
      const recovering = await freshAgent(name);
      await vi.waitFor(
        async () => expect(await recovering.recoveryHeldForTest()).toBe(true),
        { timeout: 10_000, interval: 20 }
      );
      await expect(
        recovering.inspectSubmissionForTest("sub-cut-twice")
      ).resolves.toMatchObject({ status: "running" });
      await recovering.resetIsolateForTest().catch(() => {});

      const restarted = await freshAgent(name);
      await expect(
        restarted.waitForSubmissionForTest("sub-cut-twice", {
          timeoutMs: 15_000
        })
      ).resolves.toMatchObject({ status: "completed" });
      await tasksIdle(restarted);
      // Completed once: one question, one reply.
      const stored = (await restarted.getStoredMessages()) as Array<{
        role: string;
      }>;
      expect(stored.map((message) => message.role)).toEqual([
        "user",
        "assistant"
      ]);
    }, 40_000);

    it("ends in error, without asking the model again, when its turn started longer ago than the stale window", async () => {
      const name = crypto.randomUUID();
      const agent = await freshAgent(name);
      // The window is far shorter than the reply's first chunk takes.
      await agent.keepSubmissionRecoveryStaleMsForTest(20);
      onTestFinished(async () =>
        (await freshAgent(name)).keepSubmissionRecoveryStaleMsForTest(
          15 * 60 * 1000
        )
      );
      await agent.setDelayedChunkResponse(["alpha ", "beta ", "gamma "], 200);
      await agent.holdChunksAfterForTest(1);
      await agent.testSubmitMessages("too old to recover", {
        submissionId: "sub-evicted-stale"
      });
      await chunkStreamHeld(agent);

      await agent.resetIsolateForTest().catch(() => {});
      const restarted = await freshAgent(name);
      await tasksIdle(restarted);

      await expect(
        restarted.inspectSubmissionForTest("sub-evicted-stale")
      ).resolves.toMatchObject({
        status: "error",
        error: "Submission was interrupted after messages were applied."
      });
      // The reply was not produced again: only what was streamed before
      // the reset is stored, if anything.
      const replies = (await restarted.getStoredMessages())
        .filter((message) => message.role === "assistant")
        .map((message) => JSON.stringify(message));
      expect(replies.length).toBeLessThanOrEqual(1);
      for (const reply of replies) {
        expect(reply).toContain("alpha");
        expect(reply).not.toContain("beta");
      }
    }, 30_000);

    it("retries a stalled reply in the same isolate, however long ago its turn started", async () => {
      const name = crypto.randomUUID();
      const agent = await freshAgent(name);
      // The stale window judges a turn a reset cut off, not a stalled one.
      await agent.keepSubmissionRecoveryStaleMsForTest(20);
      onTestFinished(async () =>
        (await freshAgent(name)).keepSubmissionRecoveryStaleMsForTest(
          15 * 60 * 1000
        )
      );
      await agent.setStallTimeoutForTest(300);
      onTestFinished(async () =>
        (await freshAgent(name)).setStallTimeoutForTest(0)
      );
      await agent.setDelayedChunkResponse(["alpha ", "beta "], 0);
      await agent.holdChunksAfterForTest(1);
      await agent.testSubmitMessages("stalls once", {
        submissionId: "sub-stalled-old"
      });
      // The reply goes quiet after its first chunk and never continues.
      await chunkStreamHeld(agent);
      await agent.abandonChunkHoldForTest();

      await vi.waitFor(
        async () =>
          expect(
            (await agent.inspectSubmissionForTest("sub-stalled-old"))?.status
          ).toBe("completed"),
        { timeout: 20_000, interval: 50 }
      );
    }, 30_000);

    // Successor of think-session's "marks the root submission errored when a
    // chained continuation is abandoned": the second reset cuts the
    // recovery's own continuation, whose request is not the submission's.
    it("ends failed, not running, when a reset cuts its recovered reply and the next recovery declines", async () => {
      const name = crypto.randomUUID();
      const agent = await freshAgent(name);
      await agent.setDelayedChunkResponse(["a ", "b ", "c ", "d "], 50);
      await agent.holdChunksAfterForTest(1);
      await agent.testSubmitMessages("interrupt me twice", {
        submissionId: "sub-chain-declined"
      });
      await chunkStreamHeld(agent);
      // The recovered reply streams, and waits after its first chunk.
      await agent.holdChunksAfterResetForTest(["e ", "f ", "g "], 50, 1);
      await agent.resetIsolateForTest().catch(() => {});
      const recovering = await freshAgent(name);
      await chunkStreamHeld(recovering);
      await recovering.answerRecoveryForTest({ continue: false });
      await recovering.resetIsolateForTest().catch(() => {});

      const restarted = await freshAgent(name);
      await expect(
        restarted.waitForSubmissionForTest("sub-chain-declined", {
          timeoutMs: 15_000
        })
      ).resolves.toMatchObject({ status: "error" });
      await tasksIdle(restarted);
      await expect(
        restarted.inspectSubmissionForTest("sub-chain-declined")
      ).resolves.toMatchObject({ status: "error" });
    }, 40_000);

    it("ends in error with the model's own error text when its recovered reply fails", async () => {
      const name = crypto.randomUUID();
      const agent = await freshAgent(name);
      await agent.setDelayedChunkResponse(["alpha ", "beta "], 200);
      await agent.holdChunksAfterForTest(1);
      await agent.testSubmitMessages("fails once recovered", {
        submissionId: "sub-recovered-fails"
      });
      await chunkStreamHeld(agent);
      // The next model call, the recovered one, fails in its stream.
      await agent.failInBandAfterResetForTest("recovered in-band failure");

      await agent.resetIsolateForTest().catch(() => {});
      const restarted = await freshAgent(name);
      await tasksIdle(restarted);

      await expect(
        restarted.inspectSubmissionForTest("sub-recovered-fails")
      ).resolves.toMatchObject({
        status: "error",
        error: "recovered in-band failure"
      });
    }, 30_000);

    it("stays aborted when it is cancelled while its reply is being recovered", async () => {
      const name = crypto.randomUUID();
      const agent = await freshAgent(name);
      await agent.setDelayedChunkResponse(["a ", "b ", "c ", "d "], 50);
      await agent.holdChunksAfterForTest(1);
      await agent.testSubmitMessages("interrupt me", {
        submissionId: "sub-evicted-cancel"
      });
      await chunkStreamHeld(agent);
      // The recovered reply waits after its first chunk too.
      await agent.holdChunksAfterResetForTest(["e ", "f ", "g "], 50, 1);
      await agent.resetIsolateForTest().catch(() => {});
      const restarted = await freshAgent(name);
      onTestFinished(() => restarted.releaseChunksForTest());
      await chunkStreamHeld(restarted);

      await expect(
        restarted.cancelSubmissionForTest("sub-evicted-cancel", "stop")
      ).resolves.toMatchObject({ outcome: "cancelled" });
      // The recovered reply ends after the cancel: it must not write a
      // completion over it.
      await restarted.releaseChunksForTest();
      await tasksIdle(restarted);
      await expect(
        restarted.inspectSubmissionForTest("sub-evicted-cancel")
      ).resolves.toMatchObject({ status: "aborted", error: "stop" });
    }, 30_000);
  });

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
    const stored = await agent.getStoredMessages();
    expect(stored).toHaveLength(2);
    expect(stored[1].role).toBe("assistant");
    expect(completed.messageId).toBe(stored[1].id);

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

  it("stores a submitted message over 1.8 MB whole", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["ok"], 1);
    const text = "y".repeat(2_000_000);

    await agent.testSubmitMessages(text, { submissionId: "sub-large" });
    await waitForSubmission(
      agent,
      "sub-large",
      (submission) => submission.status === "completed"
    );

    const stored = await agent.getStoredMessages();
    const part = stored[0]?.parts?.[0] as { text?: string } | undefined;
    expect(part?.text).toBe(text);
    expect(stored[0]?.metadata).toBeUndefined();
  });

  it("detached notify submits a follow-up turn that drains to a model response", async () => {
    const agent = await freshAgent();
    await agent.setProgrammaticResponseForTest("Background follow-up");

    await agent.notifyDetachedFinishForTest({
      runId: "notify-run",
      notifySource: "agents-as-tools-background"
    });

    const completed = await waitForSubmissionByKey(
      agent,
      "detached-finish:notify-run:completed",
      (submission) => submission.status === "completed"
    );

    expect(completed).toMatchObject({
      idempotencyKey: "detached-finish:notify-run:completed",
      metadata: {
        source: "agents-as-tools-background",
        runId: "notify-run",
        agentType: "Researcher",
        status: "completed"
      }
    });
    expect(textParts(await agent.getStoredMessages())).toEqual([
      'Background task "Researcher" (run notify-run) finished:\n\n' +
        "detached summary",
      "Background follow-up"
    ]);
  });

  it("detached milestone notify submits once and is idempotent across re-delivery", async () => {
    const agent = await freshAgent();
    await agent.setProgrammaticResponseForTest("Reacting to the milestone");

    // Called twice (warm tail + backbone reconcile re-delivery); the
    // idempotency key must collapse them to a single synthetic turn.
    await agent.notifyDetachedMilestoneForTest({
      runId: "ms-run",
      name: "sources-gathered",
      notifySource: "agents-as-tools-background",
      times: 2
    });

    const completed = await waitForSubmissionByKey(
      agent,
      "detached-ms:ms-run:sources-gathered",
      (submission) => submission.status === "completed"
    );

    expect(completed).toMatchObject({
      idempotencyKey: "detached-ms:ms-run:sources-gathered",
      metadata: {
        source: "agents-as-tools-background",
        runId: "ms-run",
        milestone: "sources-gathered"
      }
    });

    // Exactly one milestone message injected despite two delivery attempts.
    const milestoneMessages = textParts(await agent.getStoredMessages()).filter(
      (text) => text.includes('reached milestone "sources-gathered"')
    );
    expect(milestoneMessages).toHaveLength(1);
  });

  it("detached milestone narrate injects a synthetic assistant line with no model turn", async () => {
    const agent = await freshAgent();
    // If narrate were to trigger inference, this would surface as a second
    // assistant message — it must NOT.
    await agent.setProgrammaticResponseForTest("SHOULD NOT APPEAR");

    await agent.notifyDetachedMilestoneForTest({
      runId: "ms-narrate",
      name: "sources-gathered",
      notifySource: "agents-as-tools-background",
      mode: "narrate",
      times: 2
    });

    const stored = await agent.getStoredMessages();
    const texts = textParts(stored);
    const milestoneLines = texts.filter((text) =>
      text.includes('reached milestone "sources-gathered"')
    );
    // Idempotent (deterministic id) → exactly one line despite two deliveries.
    expect(milestoneLines).toHaveLength(1);
    // No inference ran, so the programmatic model response never appears.
    expect(texts).not.toContain("SHOULD NOT APPEAR");
    // It is the assistant speaking, not a synthetic "user" turn.
    const milestoneMessage = stored.find((message) =>
      (message.parts ?? []).some(
        (part) =>
          (part as { type?: string }).type === "text" &&
          ((part as { text?: string }).text ?? "").includes(
            'reached milestone "sources-gathered"'
          )
      )
    );
    expect(milestoneMessage?.role).toBe("assistant");
  });

  it("detached notify created during an active turn drains after that turn", async () => {
    const agent = await freshAgent();
    await agent.setProgrammaticResponseForTest("Model response");

    await expect(
      agent.runNestedAdmissionScenario("detachedNotify")
    ).resolves.toEqual({
      attempted: true,
      succeeded: true,
      error: null
    });

    const completed = await waitForSubmissionByKey(
      agent,
      "detached-finish:nested-detached-notify:completed",
      (submission) => submission.status === "completed"
    );

    expect(completed.error).toBeUndefined();
    expect(completed.metadata).toMatchObject({
      source: "nested-detached-source",
      runId: "nested-detached-notify",
      agentType: "Researcher",
      status: "completed"
    });
    expect(textParts(await agent.getStoredMessages())).toContain(
      'Background task "Researcher" (run nested-detached-notify) finished:\n\n' +
        "detached summary"
    );
  });

  it("serializes a fast-path/backbone detached delivery behind an active turn", async () => {
    const agent = await freshAgent();

    // A serialized delivery dispatched while a turn occupies the queue must run
    // strictly after that turn, never interleaved with it (#1752 fix #2).
    expect(await agent.serializedDetachedDeliveryOrderingForTest()).toEqual([
      "turn",
      "delivery"
    ]);
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

  it("links the partial persisted after cancellation to the aborted submission", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(
      Array.from({ length: 40 }, (_, i) => `w${i} `),
      50
    );

    // The stream sends two chunks and waits, so there is a partial to keep.
    await agent.holdChunksAfterForTest(2);
    onTestFinished(() => agent.releaseChunksForTest());

    const accepted = await agent.testSubmitMessages("cancel me", {
      submissionId: "sub-cancel-partial"
    });
    await vi.waitFor(
      async () => expect(await agent.isChunkStreamHeldForTest()).toBe(true),
      { timeout: 5000, interval: 10 }
    );
    await agent.cancelSubmissionForTest(accepted.submissionId, "stop");
    // The mock model ignores the abort; let it run on so the turn sees it.
    await agent.releaseChunksForTest();
    await waitForSubmission(
      agent,
      accepted.submissionId,
      (submission) => submission.status === "aborted"
    );

    let assistant: { id: string; role: string } | undefined;
    await vi.waitFor(
      async () => {
        assistant = (await agent.getStoredMessages()).find(
          (message) => message.role === "assistant"
        );
        expect(assistant).toBeDefined();
      },
      { timeout: 5000, interval: 10 }
    );
    await expect(
      agent.inspectSubmissionForTest(accepted.submissionId)
    ).resolves.toMatchObject({ status: "aborted", messageId: assistant?.id });
  });

  it("does not link a cancelled turn's partial to a reused submission id", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(
      Array.from({ length: 40 }, (_, i) => `w${i} `),
      50
    );

    // The first stream sends two chunks and waits, so its turn has a partial.
    await agent.holdChunksAfterForTest(2);
    onTestFinished(() => agent.releaseChunksForTest());

    const first = await agent.testSubmitMessages("cancel me", {
      submissionId: "sub-reused"
    });
    await vi.waitFor(
      async () => expect(await agent.isChunkStreamHeldForTest()).toBe(true),
      { timeout: 5000, interval: 10 }
    );
    // Deleted, reused and the reuse cancelled while the first turn's stream
    // is still held, so its partial lands after the reuse exists.
    await agent.cancelSubmissionForTest(first.submissionId, "stop");
    await agent.deleteSubmissionForTest(first.submissionId);
    const second = await agent.testSubmitMessages("again", {
      submissionId: "sub-reused"
    });
    await agent.cancelSubmissionForTest(second.submissionId, "stop");
    // The mock model ignores the abort; let it run on so the turn sees it.
    await agent.releaseChunksForTest();
    await waitForSubmission(
      agent,
      second.submissionId,
      (submission) => submission.status === "aborted"
    );
    // The first turn's partial is stored: the write that must not link to
    // the reused id has happened.
    await vi.waitFor(
      async () =>
        expect(
          (await agent.getStoredMessages()).some(
            (message) => message.role === "assistant"
          )
        ).toBe(true),
      { timeout: 5000, interval: 10 }
    );

    const submission = await agent.inspectSubmissionForTest("sub-reused");
    expect(submission?.status).toBe("aborted");
    expect(submission?.messageId).toBeUndefined();
  });

  it("aborts a running submission without letting late completion overwrite it", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["a ", "b ", "c ", "d "], 50);
    // The stream waits after one chunk, so the cancel lands mid-turn.
    await agent.holdChunksAfterForTest(1);
    onTestFinished(() => agent.releaseChunksForTest());

    const accepted = await agent.testSubmitMessages("cancel me", {
      submissionId: "sub-cancel"
    });
    await chunkStreamHeld(agent);
    await agent.cancelSubmissionForTest(accepted.submissionId, "stop");

    const aborted = await waitForSubmission(
      agent,
      accepted.submissionId,
      (submission) => submission.status === "aborted"
    );

    expect(aborted.error).toBe("stop");
    // The stream finishes after the abort; once the turn has ended, a late
    // completion would have been written.
    await agent.releaseChunksForTest();
    await agent.waitForIdleForTest();
    await expect(
      agent.inspectSubmissionForTest(accepted.submissionId)
    ).resolves.toMatchObject({ status: "aborted" });
  });

  it("does not append a running submission cancelled before its queued turn slot", async () => {
    const agent = await freshAgent();

    const result = await agent.cancelQueuedRunningSubmissionBeforeSlotForTest({
      submissionId: "sub-queued-running-cancel"
    });

    expect(result.submission).toMatchObject({
      status: "aborted",
      error: "cancelled before queue slot"
    });
    expect(textParts(result.messages)).toContain("active turn");
    expect(textParts(result.messages)).not.toContain("queued then cancelled");
    expect(
      result.messages.filter((message) => message.role === "user")
    ).toHaveLength(1);
    expect(
      result.responses.map((response) => response.requestId)
    ).not.toContain("sub-queued-running-cancel");
    expect(result.submissionLog.map((submission) => submission.status)).toEqual(
      expect.arrayContaining(["pending", "running", "aborted"])
    );
  });

  it("does not partially append multi-message submissions cancelled before their queued turn slot", async () => {
    const agent = await freshAgent();

    const result = await agent.cancelQueuedRunningSubmissionBeforeSlotForTest({
      submissionId: "sub-queued-running-multi-cancel",
      messageTexts: [
        "queued cancelled first",
        "queued cancelled second",
        "queued cancelled third"
      ]
    });

    const persistedTexts = textParts(result.messages);
    expect(result.submission).toMatchObject({
      status: "aborted",
      error: "cancelled before queue slot"
    });
    expect(persistedTexts).toContain("active turn");
    expect(persistedTexts).not.toContain("queued cancelled first");
    expect(persistedTexts).not.toContain("queued cancelled second");
    expect(persistedTexts).not.toContain("queued cancelled third");
    expect(
      result.messages.filter((message) => message.role === "user")
    ).toHaveLength(1);
  });

  it("emits an aborted workflow notification without appending a queued cancelled prompt", async () => {
    const agent = await freshAgent();

    const result = await agent.cancelQueuedRunningSubmissionBeforeSlotForTest({
      submissionId: "sub-queued-workflow-cancel",
      metadata: {
        [workflowPromptMetadataKey]: {
          workflow: {
            name: "TEST_WORKFLOW",
            id: "workflow-queued-cancel",
            stepName: "draft-report",
            eventType: "think-prompt-queued-cancel"
          },
          output: { schema: { type: "object" } },
          fingerprint: "queued-cancel"
        }
      }
    });

    expect(result.submission).toMatchObject({
      status: "aborted",
      error: "cancelled before queue slot"
    });
    expect(textParts(result.messages)).not.toContain("queued then cancelled");
    expect(result.workflowEvents).toContainEqual(
      expect.objectContaining({
        workflowName: "TEST_WORKFLOW",
        workflowId: "workflow-queued-cancel",
        event: {
          type: "think-prompt-queued-cancel",
          payload: {
            submissionId: "sub-queued-workflow-cancel",
            status: "aborted",
            error: "cancelled before queue slot"
          }
        }
      })
    );
  });

  it("queues a submission's workflow event once, even when its terminal report repeats", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-workflow-once",
      metadata: {
        [workflowPromptMetadataKey]: {
          workflow: {
            name: "TEST_WORKFLOW",
            id: "workflow-once",
            stepName: "draft-report",
            eventType: "think-prompt-once"
          }
        }
      }
    });
    await agent.cancelSubmissionForTest("sub-workflow-once", "stop");
    await agent.drainWorkflowNotificationsForTest();
    // The report runs again, as after a reset during onSubmissionStatus.
    await agent.repeatSubmissionReportForTest("sub-workflow-once");
    await agent.drainWorkflowNotificationsForTest();
    const events = (await agent.getWorkflowEventsForTest()).filter(
      (entry) => entry.workflowId === "workflow-once"
    );
    expect(events).toHaveLength(1);
    expect(
      (await agent.getSubmissionLog()).filter(
        (entry) =>
          entry.submissionId === "sub-workflow-once" &&
          entry.status === "aborted"
      )
    ).toHaveLength(2);
  });

  it("waitForSubmission resolves when a running submission completes", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["slow ", "response"], 50);
    const accepted = await agent.testSubmitMessages("wait for me", {
      submissionId: "sub-wait"
    });
    expect(accepted.status).not.toBe("completed");

    const settled = await agent.waitForSubmissionForTest(accepted.submissionId);

    expect(settled).toMatchObject({ status: "completed" });
    expect(settled?.messageId).toBeTruthy();
    await expect(
      agent.waitForSubmissionForTest(accepted.submissionId)
    ).resolves.toEqual(settled);
    await expect(
      agent.waitForSubmissionForTest("sub-missing")
    ).resolves.toBeNull();
  });

  it("waitForSubmission resolves on cancellation and on reset", async () => {
    // Two agents: on one, the cancel would make the second submission the
    // head of its lane and wake it, so it could start before the reset.
    const agent = await freshAgent();
    const resetAgent = await freshAgent();
    await agent.insertSubmissionForTest({ submissionId: "sub-wait-cancel" });
    await resetAgent.insertSubmissionForTest({
      submissionId: "sub-wait-reset"
    });

    const cancelled = agent.waitForSubmissionForTest("sub-wait-cancel");
    const reset = resetAgent.waitForSubmissionForTest("sub-wait-reset");
    await agent.cancelSubmissionForTest("sub-wait-cancel", "stop");
    await expect(cancelled).resolves.toMatchObject({
      status: "aborted",
      error: "stop"
    });
    await resetAgent.resetTurnStateForTest();
    await expect(reset).resolves.toMatchObject({ status: "skipped" });
  });

  it("waitForSubmission returns the current state when it times out", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({ submissionId: "sub-wait-timeout" });

    await expect(
      agent.waitForSubmissionForTest("sub-wait-timeout", { timeoutMs: 50 })
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("waitForSubmission waits for onSubmissionStatus after the terminal write", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({ submissionId: "sub-wait-hook" });
    await agent.holdSubmissionStatusHookForTest();
    onTestFinished(() => agent.releaseSubmissionStatusHookForTest());

    // The terminal row is written and its hook is running.
    const cancel = agent.cancelSubmissionForTest("sub-wait-hook", "stop");
    await statusHookHeld(agent);
    let waitSettled = false;
    const waiting = agent.waitForSubmissionForTest("sub-wait-hook");
    waiting.then(
      () => {
        waitSettled = true;
      },
      () => {
        // A rejected wait fails the test where it is awaited below.
      }
    );
    // After a round trip to the agent, the wait still waits for the hook.
    await agent.isSubmissionStatusHookHeldForTest();
    expect(waitSettled).toBe(false);
    await agent.releaseSubmissionStatusHookForTest();
    await expect(waiting).resolves.toMatchObject({ status: "aborted" });
    const hookRan = (await agent.getSubmissionLog()).some(
      (entry) =>
        entry.submissionId === "sub-wait-hook" && entry.status === "aborted"
    );
    await cancel;
    expect(hookRan).toBe(true);
  });

  it("waitForSubmission resolves when a terminal submission is deleted before its status is emitted", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({ submissionId: "sub-wait-deleted" });

    const waiting = agent.waitForSubmissionForTest("sub-wait-deleted");
    await agent.setSubmissionRowStatusForTest("sub-wait-deleted", "completed");
    await expect(
      agent.deleteSubmissionForTest("sub-wait-deleted")
    ).resolves.toBe(true);
    const settled = await Promise.race([
      waiting,
      new Promise<"stranded">((resolve) =>
        setTimeout(() => resolve("stranded"), 1000)
      )
    ]);
    expect(settled).toMatchObject({ status: "completed" });
  });

  it("does not settle a reused submission id with the deleted submission's result", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({ submissionId: "sub-reuse" });
    await agent.holdSubmissionStatusHookForTest();
    onTestFinished(() => agent.releaseSubmissionStatusHookForTest());

    // Deleted and reused while its terminal hook runs.
    const cancel = agent.cancelSubmissionForTest("sub-reuse", "stop");
    await statusHookHeld(agent);
    await expect(agent.deleteSubmissionForTest("sub-reuse")).resolves.toBe(
      true
    );
    await agent.insertSubmissionForTest({
      submissionId: "sub-reuse",
      createdAt: Date.now() + 1000
    });
    const waiting = agent.waitForSubmissionForTest("sub-reuse", {
      timeoutMs: 400
    });
    await agent.releaseSubmissionStatusHookForTest();
    await cancel;
    await expect(waiting).resolves.toMatchObject({ status: "pending" });
  });

  it("holds a wait until the hook finishes when the submission is deleted during it", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({ submissionId: "sub-del-hook" });
    await agent.holdSubmissionStatusHookForTest();
    onTestFinished(() => agent.releaseSubmissionStatusHookForTest());

    const waiting = agent.waitForSubmissionForTest("sub-del-hook");
    const cancel = agent.cancelSubmissionForTest("sub-del-hook", "stop");
    // Deleted while its terminal hook runs.
    await statusHookHeld(agent);
    let waitSettled = false;
    waiting.then(
      () => {
        waitSettled = true;
      },
      () => {
        // A rejected wait fails the test where it is awaited below.
      }
    );
    await expect(agent.deleteSubmissionForTest("sub-del-hook")).resolves.toBe(
      true
    );
    // Deleted, but the hook still runs: the wait has not settled.
    await agent.isSubmissionStatusHookHeldForTest();
    expect(waitSettled).toBe(false);
    await agent.releaseSubmissionStatusHookForTest();
    // The waiter gets it as it settled, with the cancel's reason, though
    // the record is gone by now.
    await expect(waiting).resolves.toMatchObject({
      status: "aborted",
      error: "stop"
    });
    const hookRan = (await agent.getSubmissionLog()).some(
      (entry) =>
        entry.submissionId === "sub-del-hook" && entry.status === "aborted"
    );
    await cancel;
    expect(hookRan).toBe(true);
  });

  it("waitForSubmission throws inside the turn that submitted it instead of deadlocking", async () => {
    const agent = await freshAgent();

    const result = await agent.runNestedAdmissionScenario("submitThenWait");

    expect(result.attempted).toBe(true);
    expect(result.succeeded).toBe(false);
    expect(result.error).toContain(
      "waitForSubmission() cannot be called from inside an active turn"
    );
  });

  it("waitForSubmission waits for work a turn left running, while a later turn runs", async () => {
    const agent = await freshAgent();
    // The work was started inside a turn, but it is not inside one now.
    await expect(agent.waitFromWorkATurnLeftRunningForTest()).resolves.toBe(
      "completed"
    );
  });

  it("waitForSubmission throws from onSubmissionStatus for its own submission", async () => {
    const agent = await freshAgent();
    await agent.waitInSubmissionStatusHookForTest();
    await agent.insertSubmissionForTest({ submissionId: "sub-hook-self" });

    await agent.cancelSubmissionForTest("sub-hook-self", "stop");

    const waits = await agent.getSubmissionStatusHookWaitsForTest();
    expect(waits).toHaveLength(1);
    expect(waits[0]).toContain(
      "error:waitForSubmission() cannot be called from onSubmissionStatus"
    );
    await expect(
      agent.waitForSubmissionForTest("sub-hook-self")
    ).resolves.toMatchObject({ status: "aborted" });
  });

  it("emits a cancelled running submission's terminal status once", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["a ", "b ", "c ", "d "], 50);
    // The stream waits after one chunk, so the cancel lands mid-turn.
    await agent.holdChunksAfterForTest(1);
    onTestFinished(() => agent.releaseChunksForTest());
    const accepted = await agent.testSubmitMessages("cancel me once", {
      submissionId: "sub-cancel-once"
    });
    await chunkStreamHeld(agent);

    await agent.cancelSubmissionForTest(accepted.submissionId, "stop");
    await expect(
      agent.waitForSubmissionForTest(accepted.submissionId)
    ).resolves.toMatchObject({ status: "aborted" });
    // Once the turn has ended, a second terminal status would have been
    // emitted.
    await agent.releaseChunksForTest();
    await agent.waitForIdleForTest();

    const statuses = (await agent.getSubmissionLog())
      .filter((entry) => entry.submissionId === accepted.submissionId)
      .map((entry) => entry.status);
    expect(statuses).toEqual(["pending", "running", "aborted"]);
  });

  it("runs a submission's status hooks in order: a held one holds the next", async () => {
    const agent = await freshAgent();
    // Its own id each run: the queue counts are per isolate, and a retry
    // may share it.
    const id = `sub-status-order-${crypto.randomUUID()}`;
    await agent.holdSubmissionStatusHookForTest();
    // The first report (pending) is held, so acceptance waits on it.
    const accepting = agent.testSubmitMessages("held status", {
      submissionId: id
    });
    await vi.waitFor(async () => {
      expect(await agent.isSubmissionStatusHookHeldForTest()).toBe(true);
    });
    // Reported while the pending hook is still running: the submission is
    // aborted before the held hook returns, so the reports overlap.
    const cancelling = agent.cancelSubmissionForTest(id, "stop");
    await vi.waitFor(async () => {
      // The aborted report has reached the queue: pending, then aborted.
      expect(await agent.statusReportsQueuedForTest(id)).toBeGreaterThanOrEqual(
        2
      );
    });
    await agent.releaseSubmissionStatusHookForTest();
    await accepting;
    await cancelling;
    await agent.waitForSubmissionForTest(id);

    const statuses = (await agent.getSubmissionLog())
      .filter((entry) => entry.submissionId === id)
      .map((entry) => entry.status);
    expect(statuses[0]).toBe("pending");
    expect(statuses.at(-1)).toBe("aborted");
  });

  it("says a submission cancelled from its running hook applied no messages", async () => {
    const agent = await freshAgent();
    await agent.cancelInSubmissionStatusHookForTest();
    const accepted = await agent.testSubmitMessages("cancel before applying", {
      submissionId: "sub-hook-cancel-applied"
    });
    await agent.waitForSubmissionForTest(accepted.submissionId);
    expect(await agent.hookCancelResultForTest()).toMatchObject({
      outcome: "cancelled",
      messagesApplied: false
    });
    expect(textParts(await agent.getStoredMessages())).not.toContain(
      "cancel before applying"
    );
  });

  it("throws from a submission's own status hook when it waits for it, and outside waits still end", async () => {
    const agent = await freshAgent();
    await agent.waitInSubmissionStatusHookForTest();
    const accepted = await agent.testSubmitMessages("wait in my hook", {
      submissionId: `sub-self-wait-${crypto.randomUUID()}`
    });
    const settled = await agent.waitForSubmissionForTest(accepted.submissionId);
    expect(settled?.status).toBe("completed");
    const waits = await agent.getSubmissionStatusHookWaitsForTest();
    expect(waits[0]).toContain(
      "error:waitForSubmission() cannot be called from onSubmissionStatus"
    );
  });

  it("hands a waiter the result when the terminal hook deletes the submission", async () => {
    const agent = await freshAgent();
    await agent.holdSubmissionStatusHookForTest("completed");
    const accepted = await agent.testSubmitMessages("deleted in my hook", {
      submissionId: `sub-deleted-${crypto.randomUUID()}`
    });
    const waiting = agent.waitForSubmissionForTest(accepted.submissionId);
    await vi.waitFor(async () => {
      expect(await agent.isSubmissionStatusHookHeldForTest()).toBe(true);
    });
    expect(await agent.deleteSubmissionForTest(accepted.submissionId)).toBe(
      true
    );
    await agent.releaseSubmissionStatusHookForTest();
    const settled = await waiting;
    expect(settled).toMatchObject({ status: "completed" });
    expect(settled?.completedAt).toBeDefined();
  });

  it("refuses a wait from a status hook on a submission still open", async () => {
    const agent = await freshAgent();
    await agent.holdSubmissionStatusHookForTest("running");
    const first = await agent.testSubmitMessages("first", {
      submissionId: `sub-hook-first-${crypto.randomUUID()}`
    });
    await vi.waitFor(async () => {
      expect(await agent.isSubmissionStatusHookHeldForTest()).toBe(true);
    });
    const second = await agent.testSubmitMessages("second", {
      submissionId: `sub-hook-second-${crypto.randomUUID()}`
    });
    // From inside the held hook of the first, the second cannot settle.
    expect(await agent.waitFromHeldHookForTest(second.submissionId)).toContain(
      "waitForSubmission() cannot be called from onSubmissionStatus"
    );
    await agent.releaseSubmissionStatusHookForTest();
    await agent.waitForSubmissionForTest(first.submissionId);
    await agent.waitForSubmissionForTest(second.submissionId);
  });

  it("lets a status hook cancel its own submission", async () => {
    const agent = await freshAgent();
    await agent.cancelInSubmissionStatusHookForTest();
    const accepted = await agent.testSubmitMessages("cancel myself", {
      submissionId: "sub-self-cancel"
    });
    const settled = await agent.waitForSubmissionForTest(accepted.submissionId);
    expect(settled).toMatchObject({ status: "aborted" });
    const statuses = (await agent.getSubmissionLog())
      .filter((entry) => entry.submissionId === "sub-self-cancel")
      .map((entry) => entry.status);
    expect(statuses).toEqual(["pending", "running", "aborted"]);
  });

  it("aborts a submission cancelled while its running hook is in flight", async () => {
    const agent = await freshAgent();
    await agent.setSubmissionStatusDelayForTest(150);
    const accepted = await agent.testSubmitMessages("cancel in hook", {
      submissionId: "sub-cancel-hook"
    });
    await waitForSubmission(
      agent,
      accepted.submissionId,
      (submission) => submission.status === "running"
    );

    await expect(
      agent.cancelSubmissionForTest(accepted.submissionId, "stop")
    ).resolves.toMatchObject({
      outcome: "cancelled",
      previousStatus: "running",
      messagesApplied: false
    });
    const settled = await agent.waitForSubmissionForTest(accepted.submissionId);
    expect(settled).toMatchObject({ status: "aborted", error: "stop" });
    // Once the turn queue is idle and no Tasks run is open (the claim and
    // its status reports run as a task, not a turn), a late status would
    // have been reported.
    await agent.waitForIdleForTest();
    await vi.waitFor(
      async () => expect(await agent.isTasksIdleForTest()).toBe(true),
      { timeout: 5000, interval: 10 }
    );

    const statuses = (await agent.getSubmissionLog())
      .filter((entry) => entry.submissionId === accepted.submissionId)
      .map((entry) => entry.status);
    expect(statuses).toEqual(["pending", "running", "aborted"]);
    expect(textParts(await agent.getStoredMessages())).not.toContain(
      "cancel in hook"
    );
  });

  it("waitForSubmission on a skipped submission waits for its own status hook", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({ submissionId: "sub-reset-a" });
    await agent.insertSubmissionForTest({ submissionId: "sub-reset-b" });
    await agent.setSubmissionStatusDelayForTest(150);

    await agent.resetTurnStateForTest();
    const settled = await agent.waitForSubmissionForTest("sub-reset-b");

    expect(settled).toMatchObject({ status: "skipped" });
    const hookRan = (await agent.getSubmissionLog()).some(
      (entry) =>
        entry.submissionId === "sub-reset-b" && entry.status === "skipped"
    );
    expect(hookRan).toBe(true);
  });

  it("does not let a cancelled submission's skipped turn pick a continuation's channel", async () => {
    const agent = await freshAgent();

    await agent.cancelQueuedRunningSubmissionBeforeSlotForTest({
      submissionId: "sub-cancelled-channel",
      channel: "voice"
    });
    await agent.testRunTurnWait({ continuation: true });

    const captured = await agent.getCapturedOptions();
    expect(captured.at(-1)).toMatchObject({ continuation: true });
    expect(captured.at(-1)?.channel).toBeUndefined();
  });

  it("forgets the last turn's channel on reset", async () => {
    const agent = await freshAgent();
    await agent.testSubmitMessages("before reset", {
      submissionId: "sub-before-reset"
    });
    await waitForSubmission(
      agent,
      "sub-before-reset",
      (submission) => submission.status === "completed"
    );
    await agent.testRunTurnWait({ continuation: true, channel: "voice" });
    expect((await agent.getCapturedOptions()).at(-1)?.channel).toBe("voice");

    await agent.resetTurnStateForTest();
    await agent.testRunTurnWait({ continuation: true });

    const captured = await agent.getCapturedOptions();
    expect(captured.at(-1)).toMatchObject({ continuation: true });
    expect(captured.at(-1)?.channel).toBeUndefined();
  });

  it("does not count a message id that was already in the conversation", async () => {
    const agent = await freshAgent();
    await agent.persistAssistantMessageForTest({
      id: "sub-existing-a",
      role: "user",
      parts: [{ type: "text", text: "earlier" }]
    });
    await agent.insertSubmissionForTest({
      submissionId: "sub-existing",
      status: "running",
      messageIds: ["sub-existing-a"]
    });
    await agent.markSubmissionRunningHereForTest("sub-existing");

    await expect(
      agent.cancelSubmissionForTest("sub-existing")
    ).resolves.toMatchObject({
      outcome: "cancelled",
      previousStatus: "running",
      messagesApplied: false
    });
  });

  it("checks stored messages for a submission claimed before a restart", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-partial",
      status: "running",
      messageIds: ["sub-partial-a", "sub-partial-b"]
    });
    await agent.persistAssistantMessageForTest({
      id: "sub-partial-a",
      role: "user",
      parts: [{ type: "text", text: "first" }]
    });

    await expect(
      agent.cancelSubmissionForTest("sub-partial")
    ).resolves.toMatchObject({
      outcome: "cancelled",
      previousStatus: "running",
      messagesApplied: true
    });
  });

  it("reports whether a cancelled submission's messages were applied", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-claimed",
      status: "running"
    });
    await agent.insertSubmissionForTest({
      submissionId: "sub-applied",
      status: "running",
      messagesAppliedAt: Date.now()
    });

    await expect(
      agent.cancelSubmissionForTest("sub-claimed")
    ).resolves.toMatchObject({
      outcome: "cancelled",
      previousStatus: "running",
      messagesApplied: false
    });
    await expect(
      agent.cancelSubmissionForTest("sub-applied")
    ).resolves.toMatchObject({
      outcome: "cancelled",
      previousStatus: "running",
      messagesApplied: true
    });
  });

  it("reports what cancelSubmission did", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["a ", "b ", "c ", "d "], 50);

    await expect(agent.cancelSubmissionForTest("sub-missing")).resolves.toEqual(
      { outcome: "not_found", submissionId: "sub-missing" }
    );

    await agent.insertSubmissionForTest({
      submissionId: "sub-outcome-pending"
    });
    await expect(
      agent.cancelSubmissionForTest("sub-outcome-pending", "not needed")
    ).resolves.toMatchObject({
      outcome: "cancelled",
      previousStatus: "pending",
      messagesApplied: false,
      submission: { status: "aborted", error: "not needed" }
    });
    await expect(
      agent.cancelSubmissionForTest("sub-outcome-pending")
    ).resolves.toMatchObject({
      outcome: "already_terminal",
      submission: { status: "aborted", error: "not needed" }
    });

    // The stream waits after one chunk, so the cancel finds it running.
    await agent.holdChunksAfterForTest(1);
    onTestFinished(() => agent.releaseChunksForTest());
    const running = await agent.testSubmitMessages("cancel me", {
      submissionId: "sub-outcome-running"
    });
    await chunkStreamHeld(agent);
    const cancelled = await agent.cancelSubmissionForTest(
      running.submissionId,
      "stop"
    );
    await agent.releaseChunksForTest();
    expect(cancelled).toMatchObject({
      outcome: "cancelled",
      previousStatus: "running",
      submission: { status: "aborted", error: "stop" }
    });
    expect(
      cancelled.outcome === "cancelled" && cancelled.submission.startedAt
    ).toBeTruthy();

    const other = await freshAgent();
    const completed = await other.testSubmitMessages("finish", {
      submissionId: "sub-outcome-completed"
    });
    await waitForSubmission(
      other,
      completed.submissionId,
      (submission) => submission.status === "completed"
    );
    await expect(
      other.cancelSubmissionForTest(completed.submissionId)
    ).resolves.toMatchObject({
      outcome: "already_terminal",
      submission: { status: "completed" }
    });
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

  it("queues the aborted notification atomically when a pending workflow submission is cancelled", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-workflow-cancel",
      metadata: {
        [workflowPromptMetadataKey]: {
          workflow: {
            name: "TEST_WORKFLOW",
            id: "workflow-cancel",
            stepName: "draft-report",
            eventType: "think-prompt-cancel"
          },
          output: { schema: { type: "object" } },
          fingerprint: "fingerprint"
        }
      }
    });

    await agent.cancelSubmissionForTest("sub-workflow-cancel", "not needed");
    await agent.drainWorkflowNotificationsForTest();

    await expect(agent.listWorkflowNotificationsForTest()).resolves.toEqual([]);
    await expect(agent.getWorkflowEventsForTest()).resolves.toEqual([
      {
        workflowName: "TEST_WORKFLOW",
        workflowId: "workflow-cancel",
        event: {
          type: "think-prompt-cancel",
          payload: {
            submissionId: "sub-workflow-cancel",
            status: "aborted",
            error: "not needed"
          }
        }
      }
    ]);
  });

  it("tells the workflow once when its submission completes", async () => {
    const agent = await freshAgent();
    await agent.testSubmitMessages("draft the report", {
      submissionId: "sub-workflow-completed",
      metadata: {
        [workflowPromptMetadataKey]: {
          workflow: {
            name: "TEST_WORKFLOW",
            id: "workflow-completed",
            stepName: "draft-report",
            eventType: "think-prompt-completed"
          }
        }
      }
    });
    await expect(
      agent.waitForSubmissionForTest("sub-workflow-completed", {
        timeoutMs: 10_000
      })
    ).resolves.toMatchObject({ status: "completed" });
    await agent.drainWorkflowNotificationsForTest();

    await expect(agent.getWorkflowEventsForTest()).resolves.toEqual([
      {
        workflowName: "TEST_WORKFLOW",
        workflowId: "workflow-completed",
        event: {
          type: "think-prompt-completed",
          payload: {
            submissionId: "sub-workflow-completed",
            status: "completed"
          }
        }
      }
    ]);
    await expect(agent.listWorkflowNotificationsForTest()).resolves.toEqual([]);
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

  it("delivers a structured output that fits a workflow event, and fails one that does not with the reason", async () => {
    const agent = await freshAgent();
    const prompt = (id: string, eventType: string) => ({
      [workflowPromptMetadataKey]: {
        workflow: {
          name: "TEST_WORKFLOW",
          id,
          stepName: "draft-report",
          eventType
        },
        output: {
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false
          }
        },
        fingerprint: "fingerprint"
      }
    });

    await agent.setFinalAnswerResponseForTest({ title: "t".repeat(900_000) });
    await agent.testSubmitMessages("a large output", {
      submissionId: "sub-large-output",
      metadata: prompt("workflow-large", "think-prompt-large")
    });
    const delivered = await waitForWorkflowEvent(
      agent,
      (entry) => entry.event.type === "think-prompt-large"
    );
    const payload = delivered.event.payload as {
      status: string;
      output: { title: string };
    };
    expect(payload.status).toBe("completed");
    expect(payload.output.title.length).toBe(900_000);

    await agent.setFinalAnswerResponseForTest({ title: "u".repeat(1_200_000) });
    await agent.testSubmitMessages("an output too large", {
      submissionId: "sub-huge-output",
      metadata: prompt("workflow-huge", "think-prompt-huge")
    });
    const failed = await waitForWorkflowEvent(
      agent,
      (entry) => entry.event.type === "think-prompt-huge"
    );
    expect(failed.event.payload).toMatchObject({
      submissionId: "sub-huge-output",
      status: "error",
      error: expect.stringMatching(/a workflow event holds at most/)
    });
  }, 30_000);

  it("recovers a request-aborted submission as aborted, not completed", async () => {
    const agent = await freshAgent();
    await agent.setDelayedChunkResponse(["partial ", "answer"], 100);
    const submissionId = "sub-request-aborted-cutover";
    await agent.testSubmitMessages("stop this request", {
      submissionId,
      metadata: {
        [workflowPromptMetadataKey]: {
          workflow: {
            name: "TEST_WORKFLOW",
            id: "workflow-aborted-cutover",
            stepName: "draft",
            eventType: "think-prompt-aborted-cutover"
          }
        }
      }
    });
    await agent.abortSubmissionRequestForTest(submissionId);
    await waitForSubmission(
      agent,
      submissionId,
      (row) => row.status === "aborted"
    );

    await agent.recoverSubmissionSettlementForTest(submissionId);

    await expect(
      agent.inspectSubmissionForTest(submissionId)
    ).resolves.toMatchObject({
      status: "aborted"
    });
    const events = await agent.getWorkflowEventsForTest();
    expect(events).toHaveLength(1);
    expect(events[0].event.payload).toEqual({
      submissionId,
      status: "aborted"
    });
  });

  it("recovers the exact structured output recorded at stream settlement", async () => {
    const agent = await freshAgent();
    const output = { title: "Durable output", labels: ["ops", "review"] };
    await agent.setFinalAnswerResponseForTest(output);
    const submissionId = "sub-output-cutover";
    await agent.testSubmitMessages("structured output", {
      submissionId,
      metadata: {
        [workflowPromptMetadataKey]: {
          workflow: {
            name: "TEST_WORKFLOW",
            id: "workflow-output-cutover",
            stepName: "draft",
            eventType: "think-prompt-output-cutover"
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
          }
        }
      }
    });
    await waitForSubmission(
      agent,
      submissionId,
      (row) => row.status === "completed"
    );
    await agent.recoverSubmissionSettlementForTest(submissionId);

    await expect(
      agent.inspectSubmissionForTest(submissionId)
    ).resolves.toMatchObject({
      status: "completed"
    });
    const events = await agent.getWorkflowEventsForTest();
    expect(events).toHaveLength(1);
    expect(events[0].event.payload).toEqual({
      submissionId,
      status: "completed",
      output
    });
    expect(
      (await agent.getStoredMessages()).every(
        (message) => message.role !== "assistant"
      )
    ).toBe(true);
  });

  describe("structured turn interrupted mid-stream (#1727)", () => {
    const output = { title: "Recovered output", labels: ["ops"] };
    const structuredMetadata = (id: string) => ({
      [workflowPromptMetadataKey]: {
        workflow: {
          name: "TEST_WORKFLOW",
          id,
          stepName: "draft",
          eventType: `think-prompt-${id}`
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
        }
      }
    });

    async function seedRunningStructuredSubmission(
      agent: Awaited<ReturnType<typeof freshAgent>>,
      id: string
    ) {
      await agent.persistTestMessage({
        id: `u-${id}`,
        role: "user",
        parts: [{ type: "text", text: "Draft the report" }]
      });
      await agent.insertSubmissionForTest({
        submissionId: id,
        requestId: id,
        status: "running",
        metadata: structuredMetadata(id),
        messagesAppliedAt: Date.now(),
        messageIds: [`u-${id}`]
      });
    }

    it("retries a turn cut off inside its final answer and completes with the output", async () => {
      const agent = await freshAgent();
      const id = "sub-structured-final-answer-cut";
      await seedRunningStructuredSubmission(agent, id);
      await agent.setFinalAnswerResponseForTest(output);

      const scheduled = await agent.interruptChatTurnForTest({
        requestId: id,
        latestMessageId: `u-${id}`,
        latestMessageRole: "user",
        latestUserMessageId: `u-${id}`,
        chunks: [
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-start",
            toolCallId: "fa-1",
            toolName: "think_final_answer"
          },
          {
            type: "tool-input-delta",
            toolCallId: "fa-1",
            inputTextDelta: '{"title":'
          }
        ]
      });
      expect(scheduled).toEqual({
        scheduledContinueCount: 0,
        scheduledRetryCount: 1
      });
      await agent.runScheduledRecoveryRetryForTest();

      await expect(agent.inspectSubmissionForTest(id)).resolves.toMatchObject({
        status: "completed"
      });
      const events = await agent.getWorkflowEventsForTest();
      expect(events.map((entry) => entry.event.payload)).toEqual([
        { submissionId: id, status: "completed", output }
      ]);
    });

    it("continues a turn cut off after visible content and completes with the output", async () => {
      const agent = await freshAgent();
      const id = "sub-structured-text-cut";
      await seedRunningStructuredSubmission(agent, id);
      await agent.persistTestMessage({
        id: `a-${id}`,
        role: "assistant",
        parts: [{ type: "text", text: "Looking into it. " }]
      });
      await agent.setFinalAnswerResponseForTest(output);

      const scheduled = await agent.interruptChatTurnForTest({
        requestId: id,
        latestMessageId: `a-${id}`,
        latestMessageRole: "assistant",
        latestUserMessageId: `u-${id}`,
        chunks: [
          { type: "start", messageId: `a-${id}` },
          { type: "start-step" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Looking into it. " }
        ]
      });
      expect(scheduled).toEqual({
        scheduledContinueCount: 1,
        scheduledRetryCount: 0
      });
      await agent.runScheduledRecoveryContinueForTest();

      await expect(agent.inspectSubmissionForTest(id)).resolves.toMatchObject({
        status: "completed"
      });
      const events = await agent.getWorkflowEventsForTest();
      expect(events.map((entry) => entry.event.payload)).toEqual([
        { submissionId: id, status: "completed", output }
      ]);
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

  it("delivers queued workflow notifications from the alarm loop", async () => {
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
    await expect(agent.listWorkflowNotificationsForTest()).resolves.toEqual([]);
  });

  it("retries a failed workflow notification delivery", async () => {
    const agent = await freshAgent();
    await agent.setWorkflowEventFailuresForTest(1);
    await agent.insertWorkflowNotificationForTest({
      notificationId: "notification-retry",
      submissionId: "sub-retry",
      workflowName: "TEST_WORKFLOW",
      workflowId: "workflow-retry",
      eventType: "think-prompt-retry"
    });

    await agent.drainWorkflowNotificationsForTest();

    await expect(agent.getWorkflowEventsForTest()).resolves.toEqual([
      {
        workflowName: "TEST_WORKFLOW",
        workflowId: "workflow-retry",
        event: {
          type: "think-prompt-retry",
          payload: { submissionId: "sub-retry", status: "error" }
        }
      }
    ]);
    await expect(agent.listWorkflowNotificationsForTest()).resolves.toEqual([]);
  });

  it("gives up on a workflow notification once its first failure is twelve hours old", async () => {
    const agent = await freshAgent();
    await agent.setWorkflowEventFailuresForTest(1);
    await agent.insertWorkflowNotificationForTest({
      notificationId: "notification-give-up",
      submissionId: "sub-give-up",
      workflowName: "TEST_WORKFLOW",
      workflowId: "workflow-give-up",
      eventType: "think-prompt-give-up",
      firstFailedAt: Date.now() - 13 * 60 * 60 * 1000
    });

    await agent.drainWorkflowNotificationsForTest();

    // No retry was scheduled and nothing was delivered; the failure went to
    // the terminal error path instead of another backoff round.
    await expect(agent.getWorkflowEventsForTest()).resolves.toEqual([]);
    await expect(agent.listWorkflowNotificationsForTest()).resolves.toEqual([]);
    const errors = await agent.getErrorsForTest();
    expect(errors.some((message) => message.includes("giving up"))).toBe(true);
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

  it("leaves no stream evidence or outcome stamp after a submission settles", async () => {
    const agent = await freshAgent();
    const first = await agent.testSubmitMessages("First submission");
    const completed = await waitForSubmission(
      agent,
      first.submissionId,
      (submission) => submission.status === "completed"
    );
    expect(completed.requestId).toBeTruthy();
    const requestId = completed.requestId ?? first.submissionId;
    // The cutover discarded the stream rows (the durable outcome stamp is the
    // evidence), and ledger settlement cleared the stamp in turn.
    await expect(
      agent.inspectSubmissionStreamEvidenceForTest(requestId)
    ).resolves.toEqual({
      streamStatus: null,
      resultStatus: null,
      hasActiveStream: false,
      hasActiveRequestStream: false,
      resumeFrames: [{ type: "cf_agent_stream_resume_none", reason: "idle" }]
    });
    await agent.recoverSubmissionsForTest();
    await agent.recoverSubmissionsForTest();
    expect(
      (await agent.getSubmissionLog()).filter(
        (entry) =>
          entry.submissionId === first.submissionId &&
          entry.status === "completed"
      )
    ).toHaveLength(1);
  });

  it.each(["completed", "error"] as const)(
    "migrates legacy submission rows and preserves %s stream fallback",
    async (status) => {
      const agent = await freshAgent();
      const submissionId = `sub-legacy-${status}`;
      await agent.insertSubmissionForTest({
        submissionId,
        status: "running",
        messagesAppliedAt: Date.now()
      });
      await agent.seedSubmissionStreamForTest(submissionId, status);
      await agent.useLegacySubmissionSchemaForTest();
      await agent.recoverSubmissionsForTest();
      // A second startup exercises idempotent migration and terminal settlement.
      await agent.recoverSubmissionsForTest();
      await expect(
        agent.inspectSubmissionForTest(submissionId)
      ).resolves.toMatchObject({ status });
      expect(
        (await agent.getSubmissionLog()).filter((row) => row.status === status)
      ).toHaveLength(1);
    }
  );

  it.each([false, true])(
    "does not complete an overflow segment when its retry crashes pre-stream (successor accepted: %s)",
    async (successorAccepted) => {
      const agent = await freshAgent();
      const submissionId = "sub-overflow-pre-stream";
      await agent.insertSubmissionForTest({
        submissionId,
        status: "running",
        messagesAppliedAt: Date.now()
      });
      await agent.seedSubmissionStreamForTest(submissionId, "retry");
      if (successorAccepted) {
        await agent.moveSubmissionRequestForTest(
          submissionId,
          "retry-successor"
        );
      }
      await agent.recoverSubmissionsForTest();
      await expect(
        agent.inspectSubmissionForTest(submissionId)
      ).resolves.toMatchObject({
        status: "error",
        error: "Submission was interrupted after messages were applied."
      });
      expect(await agent.getStoredMessages()).toHaveLength(0);
    }
  );

  it("leaves a retry stamp recoverable while a durable retry owns the submission", async () => {
    const agent = await freshAgent();
    const submissionId = "sub-overflow-recovery-owned";
    await agent.insertSubmissionForTest({
      submissionId,
      status: "running",
      messagesAppliedAt: Date.now()
    });
    await agent.seedSubmissionStreamForTest(submissionId, "retry");
    await agent.scheduleRecoveredRetryForTest(submissionId, "tasks");
    await agent.recoverSubmissionsForTest();
    await expect(
      agent.inspectSubmissionForTest(submissionId)
    ).resolves.toMatchObject({ status: "running" });
  });

  it("moves a legacy completed submission's output into its result, with metadata past 1 MiB", async () => {
    const agent = await freshAgent();
    const now = Date.now();
    const big = "m".repeat(1_200_000);
    await agent.seedLegacySubmissionTableForTest([
      {
        submissionId: "legacy-large",
        status: "completed",
        idempotencyKey: "legacy-large-key",
        metadataJson: JSON.stringify({ big }),
        outputJson: JSON.stringify({ answer: 42 }),
        createdAt: now - 1_000,
        completedAt: now - 500
      }
    ]);
    await agent.recoverSubmissionsForTest();
    expect(await agent.hasLegacySubmissionTableForTest()).toBe(false);
    const inspected = await agent.inspectSubmissionForTest("legacy-large");
    expect(inspected?.status).toBe("completed");
    expect(String(inspected?.metadata?.big).length).toBe(1_200_000);
    await expect(
      agent.submissionResultForTest("legacy-large")
    ).resolves.toEqual({ answer: 42 });
    await expect(
      agent.testSubmitMessages("again", { idempotencyKey: "legacy-large-key" })
    ).resolves.toMatchObject({ accepted: false, submissionId: "legacy-large" });
  });

  it("moves a legacy submission whose metadata or output a run cannot hold, dropping only what does not fit", async () => {
    const agent = await freshAgent();
    const now = Date.now();
    await agent.seedLegacySubmissionTableForTest([
      {
        submissionId: "legacy-huge-metadata",
        status: "completed",
        idempotencyKey: "legacy-huge-key",
        metadataJson: JSON.stringify({
          big: "m".repeat(1_950_000),
          kept: "small"
        }),
        createdAt: now - 2_000,
        completedAt: now - 1_500,
        messageId: "legacy-huge-assistant"
      },
      {
        submissionId: "legacy-huge-output",
        status: "completed",
        outputJson: JSON.stringify({ text: "o".repeat(1_500_000) }),
        createdAt: now - 1_000,
        completedAt: now - 500
      }
    ]);
    await agent.recoverSubmissionsForTest();
    expect(await agent.hasLegacySubmissionTableForTest()).toBe(false);
    const metadataDropped = await agent.inspectSubmissionForTest(
      "legacy-huge-metadata"
    );
    expect(metadataDropped).toMatchObject({
      status: "completed",
      idempotencyKey: "legacy-huge-key",
      messageId: "legacy-huge-assistant"
    });
    expect(metadataDropped?.metadata).toEqual({ kept: "small" });
    await expect(
      agent.inspectSubmissionForTest("legacy-huge-output")
    ).resolves.toMatchObject({
      status: "completed",
      metadata: { from: "legacy" }
    });
    await expect(
      agent.submissionResultForTest("legacy-huge-output")
    ).resolves.toBeNull();
    await expect(
      agent.testSubmitMessages("again", { idempotencyKey: "legacy-huge-key" })
    ).resolves.toMatchObject({
      accepted: false,
      submissionId: "legacy-huge-metadata"
    });
  });

  it("moves an open legacy submission with metadata near the limit, and it still runs", async () => {
    const agent = await freshAgent();
    const fields: Record<string, string> = {};
    // Many small fields, near the row's room: the cut must stay cheap and
    // leave the run room to record its progress.
    for (let i = 0; i < 19_500; i++) fields[`item_${i}`] = "x".repeat(86);
    await agent.seedLegacySubmissionTableForTest([
      {
        submissionId: "legacy-open-near-limit",
        status: "pending",
        text: "still answered",
        metadataJson: JSON.stringify(fields),
        createdAt: Date.now() - 1_000
      }
    ]);
    const started = Date.now();
    await agent.recoverSubmissionsForTest();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await agent.hasLegacySubmissionTableForTest()).toBe(false);
    await agent.drainSubmissionsForTest();
    const inspected = await agent.inspectSubmissionForTest(
      "legacy-open-near-limit"
    );
    expect(inspected?.status).toBe("completed");
    expect(inspected?.messageId).toBeDefined();
    expect(Object.keys(inspected?.metadata ?? {}).length).toBeGreaterThan(
      17_000
    );
  });

  it("moves legacy metadata that used Think's progress key, and keeps a finished one's fields whole", async () => {
    const agent = await freshAgent();
    const now = Date.now();
    await agent.seedLegacySubmissionTableForTest([
      {
        // The app's `__cf_progress` field was never readable back, so it
        // frees no room when dropped.
        submissionId: "legacy-progress-key",
        status: "completed",
        metadataJson: JSON.stringify({
          __cf_progress: "p".repeat(900_000),
          a: "a".repeat(600_000),
          b: "b".repeat(500_000)
        }),
        createdAt: now - 2_000,
        completedAt: now - 1_500
      },
      {
        // Finished: it never records progress again, so it needs no room.
        submissionId: "legacy-aborted-near-limit",
        status: "aborted",
        metadataJson: JSON.stringify({ big: "m".repeat(1_850_000) }),
        createdAt: now - 1_000,
        completedAt: now - 500
      }
    ]);
    await agent.recoverSubmissionsForTest();
    expect(await agent.hasLegacySubmissionTableForTest()).toBe(false);
    const progressKey = await agent.inspectSubmissionForTest(
      "legacy-progress-key"
    );
    expect(progressKey?.status).toBe("completed");
    expect(Object.keys(progressKey?.metadata ?? {})).toEqual(["a", "b"]);
    const aborted = await agent.inspectSubmissionForTest(
      "legacy-aborted-near-limit"
    );
    expect(aborted?.status).toBe("aborted");
    expect(String(aborted?.metadata?.big).length).toBe(1_850_000);
  });

  it("records a turn's result without an output its metadata has no room for", async () => {
    const agent = await freshAgent();
    await expect(
      agent.recordLargeTurnOutputForTest("sub-large-output", 200_000)
    ).resolves.toEqual({ resultStatus: "completed", hasOutput: false });
    await expect(
      agent.recordLargeTurnOutputForTest("sub-small-output", 1_000)
    ).resolves.toEqual({ resultStatus: "completed", hasOutput: true });
    // Past one value's 1 MiB but within the metadata's room beside small
    // metadata: kept, and the write (inside the stream's settle) does not
    // throw.
    await expect(
      agent.recordLargeTurnOutputForTest("sub-mib-output", 1_200_000, 10)
    ).resolves.toEqual({ resultStatus: "completed", hasOutput: true });
  });

  it("lists the running submission when newer ones wait behind it", async () => {
    const agent = await freshAgent();
    const now = Date.now();
    await agent.insertSubmissionForTest({
      submissionId: "sub-list-running",
      status: "running",
      createdAt: now - 1_000
    });
    await agent.insertSubmissionForTest({
      submissionId: "sub-list-queued",
      createdAt: now
    });
    await expect(
      agent.listSubmissionsForTest({ status: "running", limit: 1 })
    ).resolves.toMatchObject([{ submissionId: "sub-list-running" }]);
    await expect(
      agent.listSubmissionsForTest({ status: "pending", limit: 1 })
    ).resolves.toMatchObject([{ submissionId: "sub-list-queued" }]);
  });

  it("settles on start a parked submission whose recovered turn already stamped its outcome", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-parked-done",
      status: "running",
      messagesAppliedAt: Date.now()
    });
    await agent.parkSubmissionForTest("sub-parked-done", {
      resultStatus: "aborted"
    });
    await expect(
      agent.inspectSubmissionForTest("sub-parked-done")
    ).resolves.toMatchObject({ status: "running" });
    await agent.recoverSubmissionsForTest();
    await expect(
      agent.inspectSubmissionForTest("sub-parked-done")
    ).resolves.toMatchObject({ status: "aborted" });
  });

  it("moves submissions from the retired table into the inbox, and runs the open ones", async () => {
    const agent = await freshAgent();
    const now = Date.now();
    await agent.seedLegacySubmissionTableForTest([
      {
        submissionId: "legacy-done",
        status: "completed",
        idempotencyKey: "legacy-key",
        createdAt: now - 3_000,
        startedAt: now - 3_000,
        completedAt: now - 2_500,
        messageId: "legacy-assistant"
      },
      {
        submissionId: "legacy-interrupted",
        status: "running",
        text: "interrupted before its messages were applied",
        createdAt: now - 2_000,
        startedAt: now - 2_000
      },
      {
        submissionId: "legacy-pending",
        status: "pending",
        text: "waiting",
        createdAt: now - 1_000
      },
      {
        submissionId: "legacy-broken",
        status: "pending",
        messagesJson: "{",
        createdAt: now - 500
      }
    ]);

    await agent.recoverSubmissionsForTest();
    expect(await agent.hasLegacySubmissionTableForTest()).toBe(false);
    await expect(
      agent.inspectSubmissionForTest("legacy-done")
    ).resolves.toMatchObject({
      status: "completed",
      idempotencyKey: "legacy-key",
      metadata: { from: "legacy" },
      createdAt: now - 3_000,
      completedAt: now - 2_500,
      messageId: "legacy-assistant"
    });
    // An idempotent retry of a migrated submission finds it.
    await expect(
      agent.testSubmitMessages("again", { idempotencyKey: "legacy-key" })
    ).resolves.toMatchObject({ accepted: false, submissionId: "legacy-done" });

    await agent.drainSubmissionsForTest();
    await expect(
      agent.inspectSubmissionForTest("legacy-interrupted")
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      agent.inspectSubmissionForTest("legacy-pending")
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      agent.inspectSubmissionForTest("legacy-broken")
    ).resolves.toMatchObject({
      status: "error",
      error: "Stored submission messages are invalid"
    });
    const users = (await agent.getStoredMessages()).filter(
      (message) => message.role === "user"
    );
    expect(users.map((message) => message.id)).toEqual([
      "legacy-interrupted-message",
      "legacy-pending-message"
    ]);
    // A second start finds nothing to move.
    await agent.recoverSubmissionsForTest();
    expect(
      (await agent.listSubmissionsForTest({ limit: 100 })).map(
        (submission) => submission.submissionId
      )
    ).toEqual([
      "legacy-broken",
      "legacy-pending",
      "legacy-interrupted",
      "legacy-done"
    ]);
  });

  it("moves retired-table submissions before the app's onStart runs", async () => {
    const name = crypto.randomUUID();
    const agent = await freshAgent(name);
    await agent.seedLegacySubmissionTableForTest([
      {
        submissionId: "legacy-at-start",
        status: "completed",
        createdAt: Date.now() - 1_000,
        completedAt: Date.now() - 500
      }
    ]);
    await evictDurableObject(agent as unknown as DurableObjectStub);
    const restarted = await freshAgent(name);
    await expect(restarted.getLegacySubmissionAtStartForTest()).resolves.toBe(
      "completed"
    );
  });

  it("moves a retired-table row with oversized metadata, and the rows after it", async () => {
    const agent = await freshAgent();
    const now = Date.now();
    await agent.seedLegacySubmissionTableForTest([
      {
        submissionId: "legacy-big-metadata",
        status: "completed",
        metadataJson: JSON.stringify({ schema: "x".repeat(110_000) }),
        createdAt: now - 2_000,
        completedAt: now - 1_900
      },
      {
        submissionId: "legacy-keyed",
        status: "completed",
        idempotencyKey: "order-123",
        createdAt: now - 1_000,
        completedAt: now - 900
      }
    ]);
    await agent.recoverSubmissionsForTest();
    expect(await agent.hasLegacySubmissionTableForTest()).toBe(false);
    await expect(
      agent.testSubmitMessages("retry", { idempotencyKey: "order-123" })
    ).resolves.toMatchObject({ accepted: false, submissionId: "legacy-keyed" });
    const big = await agent.inspectSubmissionForTest("legacy-big-metadata");
    expect(String(big?.metadata?.schema).length).toBe(110_000);
  });

  it("lists nothing for an empty status filter", async () => {
    const agent = await freshAgent();
    await agent.testSubmitMessages("one");
    await expect(agent.listSubmissionsForTest({ status: [] })).resolves.toEqual(
      []
    );
  });

  it("runs an interrupted submission again when its messages were not applied", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-requeue",
      status: "running",
      messagesAppliedAt: null
    });

    await agent.recoverSubmissionsForTest();
    // Nothing decides it from the evidence: it waits for its next run.
    await expect(
      agent.inspectSubmissionForTest("sub-requeue")
    ).resolves.toMatchObject({ status: "running" });

    await agent.drainSubmissionsForTest();
    await expect(
      agent.inspectSubmissionForTest("sub-requeue")
    ).resolves.toMatchObject({ status: "completed" });
    const messages = await agent.getStoredMessages();
    expect(messages.filter((message) => message.role === "user")).toHaveLength(
      1
    );
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

  it("records the message id of an assistant persisted from orphaned chunks", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-orphan",
      requestId: "sub-orphan",
      status: "running",
      messagesAppliedAt: Date.now()
    });

    await agent.persistOrphanedStreamForTest("sub-orphan", "a-orphan");

    const stored = await agent.getStoredMessages();
    expect(stored.map((message) => message.id)).toContain("a-orphan");
    expect(await agent.inspectSubmissionForTest("sub-orphan")).toMatchObject({
      messageId: "a-orphan"
    });
  });

  it("recovers an interrupted continuation into one assistant message, however often it is persisted", async () => {
    const agent = await freshAgent();

    await agent.persistContinuationOrphanForTest("req-cont", "leaf-1", 2);

    const assistants = (await agent.getStoredMessages()).filter(
      (message) => message.role === "assistant"
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0].id).toBe("leaf-1");
    expect(
      (assistants[0].parts ?? []).map((part) => (part as { text: string }).text)
    ).toEqual(["earlier", "continued"]);
  });

  it("does not recreate a deleted leaf when recovering the continuation that extended it, however often", async () => {
    const agent = await freshAgent();

    await agent.persistContinuationOrphanForTest("req-cont-gone", "leaf-1", 2, {
      deleteLeaf: true
    });

    const assistants = (await agent.getStoredMessages()).filter(
      (message) => message.role === "assistant"
    );
    expect(assistants).toEqual([]);
  });

  it("recovers an interrupted continuation into the leaf when its start chunk carries a provider id", async () => {
    const agent = await freshAgent();

    await agent.persistContinuationOrphanForTest("req-cont-id", "leaf-1", 2, {
      startMessageId: "provider-2"
    });

    const assistants = (await agent.getStoredMessages()).filter(
      (message) => message.role === "assistant"
    );
    expect(assistants.map((message) => message.id)).toEqual(["leaf-1"]);
    expect(
      (assistants[0].parts ?? []).map((part) => (part as { text: string }).text)
    ).toEqual(["earlier", "continued"]);
  });

  it("keeps the continued message's metadata when recovering an interrupted continuation", async () => {
    const agent = await freshAgent();

    await agent.persistContinuationOrphanForTest("req-cont-meta", "leaf-1", 1, {
      leafMetadata: { createdAt: 1, continuation: false },
      startMetadata: { resumed: true }
    });

    const assistants = (await agent.getStoredMessages()).filter(
      (message) => message.role === "assistant"
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0].metadata).toEqual({
      createdAt: 1,
      continuation: false,
      resumed: true
    });
  });

  it("does not duplicate a tool call the continued message already held when the continuation replays it (#1404)", async () => {
    const agent = await freshAgent();

    await agent.persistContinuationOrphanForTest(
      "req-cont-replay",
      "leaf-1",
      2,
      {
        leafParts: [
          {
            type: "tool-lookup",
            toolCallId: "call-1",
            state: "output-available",
            input: { q: "x" },
            output: "found"
          }
        ],
        chunks: [
          {
            type: "tool-input-start",
            toolCallId: "call-1",
            toolName: "lookup"
          },
          {
            type: "tool-input-available",
            toolCallId: "call-1",
            toolName: "lookup",
            input: { q: "x" }
          },
          {
            type: "tool-output-available",
            toolCallId: "call-1",
            output: "found"
          },
          { type: "text-start", id: "t2" },
          { type: "text-delta", id: "t2", delta: "continued" },
          { type: "text-end", id: "t2" }
        ]
      }
    );

    const assistants = (await agent.getStoredMessages()).filter(
      (message) => message.role === "assistant"
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0].parts).toMatchObject([
      { toolCallId: "call-1", state: "output-available", output: "found" },
      { type: "text", text: "continued" }
    ]);
  });

  it("recovers a continuation's result for a tool call the continued message already held", async () => {
    const agent = await freshAgent();

    await agent.persistContinuationOrphanForTest("req-cont-tool", "leaf-1", 2, {
      leafParts: [
        {
          type: "tool-lookup",
          toolCallId: "call-1",
          state: "approval-responded",
          input: {},
          approval: { id: "approval-1", approved: true }
        }
      ],
      chunks: [
        {
          type: "tool-output-available",
          toolCallId: "call-1",
          output: "found"
        },
        { type: "text-start", id: "t2" },
        { type: "text-delta", id: "t2", delta: "continued" },
        { type: "text-end", id: "t2" }
      ]
    });

    const assistants = (await agent.getStoredMessages()).filter(
      (message) => message.role === "assistant"
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0].parts).toMatchObject([
      { toolCallId: "call-1", state: "output-available", output: "found" },
      { type: "text", text: "continued" }
    ]);
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

  it.each([
    ["tasks", "original"],
    ["legacy-schedule", "original"],
    ["tasks", "successor"],
    ["legacy-schedule", "successor"]
  ] as const)(
    "does not error running submissions while a recovered retry is pending on %s with the %s request identity",
    async (transport, requestIdentity) => {
      const agent = await freshAgent();
      const submissionId = `sub-chat-recovery-retry-${transport}`;
      await agent.insertSubmissionForTest({
        submissionId,
        requestId:
          requestIdentity === "successor"
            ? `successor-${submissionId}`
            : submissionId,
        status: "running",
        messagesAppliedAt: Date.now()
      });
      await agent.scheduleRecoveredRetryForTest(submissionId, transport);

      await agent.recoverSubmissionsForTest();

      await expect(
        agent.inspectSubmissionForTest(submissionId)
      ).resolves.toMatchObject({
        status: "running"
      });
    }
  );

  it("does not let an unrelated recovered retry protect a running submission", async () => {
    const agent = await freshAgent();
    await agent.insertSubmissionForTest({
      submissionId: "sub-unrelated-recovery-target",
      requestId: "sub-unrelated-recovery-target",
      status: "running",
      messagesAppliedAt: Date.now()
    });
    await agent.scheduleRecoveredRetryForTest(
      "different-recovery-request",
      "tasks"
    );

    await agent.recoverSubmissionsForTest();

    await expect(
      agent.inspectSubmissionForTest("sub-unrelated-recovery-target")
    ).resolves.toMatchObject({ status: "error" });
  });

  it("does not let a terminal recovery Task protect a running submission", async () => {
    const agent = await freshAgent();
    const submissionId = "sub-terminal-recovery-task";
    await agent.insertSubmissionForTest({
      submissionId,
      requestId: submissionId,
      status: "running",
      messagesAppliedAt: Date.now()
    });
    await agent.scheduleRecoveredRetryForTest(submissionId, "tasks");
    await agent.markScheduledRecoveryTaskTerminalForTest(submissionId);

    await agent.recoverSubmissionsForTest();

    await expect(
      agent.inspectSubmissionForTest(submissionId)
    ).resolves.toMatchObject({ status: "error" });
  });

  it("does not let a recovered retry overwrite cancellation before callback delivery", async () => {
    const agent = await freshAgent();
    const submissionId = "sub-chat-recovery-retry-cancel";
    await agent.insertSubmissionForTest({
      submissionId,
      requestId: submissionId,
      status: "running",
      messagesAppliedAt: Date.now()
    });
    await agent.scheduleRecoveredRetryForTest(submissionId, "tasks");
    await agent.cancelSubmissionForTest(submissionId, "stop before retry");

    await agent.runScheduledRecoveryRetryForTest();

    await expect(
      agent.inspectSubmissionForTest(submissionId)
    ).resolves.toMatchObject({
      status: "aborted",
      error: "stop before retry"
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

  it("preserves a successful tool result across an exact storage reset and never re-executes the tool", async () => {
    const agent = await freshAgent();
    await agent.useRecoveryToolModelForTest();

    const seed = await agent.testSubmitMessages("run the tool", {
      submissionId: "sub-storage-reset-tool-seed"
    });
    await waitForSubmission(
      agent,
      seed.submissionId,
      (submission) => submission.status === "completed"
    );
    expect(await agent.getRecoveryToolExecutionsForTest()).toBe(1);

    const before = await agent.getMessagesForTest();
    expect(
      before.some((message) =>
        message.parts?.some(
          (part) =>
            typeof part === "object" &&
            part !== null &&
            "state" in part &&
            part.state === "output-available"
        )
      )
    ).toBe(true);

    await agent.insertSubmissionForTest({
      submissionId: "sub-storage-reset-tool-recovery",
      requestId: "sub-storage-reset-tool-recovery",
      status: "running",
      messagesAppliedAt: Date.now()
    });
    await agent.failNextRecoveredContinueForTest(
      "Internal error in Durable Object storage caused object to be reset"
    );

    await expect(
      agent.continueRecoveredChatCatchingForTest(
        "sub-storage-reset-tool-recovery"
      )
    ).resolves.toContain(
      "Internal error in Durable Object storage caused object to be reset"
    );
    await expect(
      agent.inspectSubmissionForTest("sub-storage-reset-tool-recovery")
    ).resolves.toMatchObject({ status: "running" });
    expect(await agent.getRecoveryToolExecutionsForTest()).toBe(1);
    expect(await agent.getMessagesForTest()).toEqual(before);

    await agent.continueRecoveredChatForTest("sub-storage-reset-tool-recovery");
    await expect(
      agent.inspectSubmissionForTest("sub-storage-reset-tool-recovery")
    ).resolves.toMatchObject({ status: "completed" });
    expect(await agent.getRecoveryToolExecutionsForTest()).toBe(1);
    expect(
      (await agent.getMessagesForTest()).some((message) =>
        message.parts?.some(
          (part) =>
            part.type === "text" &&
            "text" in part &&
            part.text.includes("Done with tools")
        )
      )
    ).toBe(true);
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

  it("ignores stream errors from non-submission callers", async () => {
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

  it("bulk deletes matches that lie past a page of submissions that do not match", async () => {
    const agent = await freshAgent();
    await agent.setThrowingStreamError("boom");
    const failed = await agent.testSubmitMessages("explode", {
      submissionId: "sub-page-error"
    });
    await waitForSubmission(
      agent,
      failed.submissionId,
      (submission) => submission.status === "error"
    );
    await agent.setThrowingStreamError(null);
    // Two completed ones after it, then one more error: with a limit of
    // one, a first page holds the earlier error only; a later call must
    // still find the second error behind the completed ones.
    for (const id of ["sub-page-ok-1", "sub-page-ok-2"]) {
      const ok = await agent.testSubmitMessages(id, { submissionId: id });
      await waitForSubmission(agent, ok.submissionId, (submission) =>
        terminalStatuses.has(submission.status)
      );
    }
    await agent.setThrowingStreamError("boom again");
    const later = await agent.testSubmitMessages("explode again", {
      submissionId: "sub-page-error-2"
    });
    await waitForSubmission(
      agent,
      later.submissionId,
      (submission) => submission.status === "error"
    );

    expect(
      await agent.deleteSubmissionsForTest({ status: "error", limit: 1 })
    ).toBe(1);
    expect(
      await agent.deleteSubmissionsForTest({ status: "error", limit: 1 })
    ).toBe(1);
    await expect(
      agent.inspectSubmissionForTest("sub-page-error-2")
    ).resolves.toBeNull();
    await expect(
      agent.inspectSubmissionForTest("sub-page-ok-1")
    ).resolves.toMatchObject({ status: "completed" });
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
      submissionId: "sub-multi-mid-completed",
      status: "completed",
      createdAt: now + 2_000,
      completedAt: now + 2_000
    });
    await agent.insertSubmissionForTest({
      submissionId: "sub-multi-new-pending",
      status: "pending",
      createdAt: now + 3_000
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
