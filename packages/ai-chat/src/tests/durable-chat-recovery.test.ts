import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { subscribe } from "agents/observability";
import type { UIMessage as ChatMessage } from "ai";

interface ChatRecoveryTestStub {
  setRecoveryOverride(options: {
    persist?: boolean;
    continue?: boolean;
  }): Promise<void>;
  getRecoveryContexts(): Promise<unknown[]>;
  getPersistedMessages(): Promise<unknown[]>;
  getPartialText(streamId?: string): Promise<unknown>;
  getOnChatMessageCallCount(): Promise<number>;
  waitForIdleForTest(): Promise<void>;
  triggerInterruptedStreamCheck(): Promise<void>;
  insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>,
    ageMs?: number
  ): Promise<void>;
  insertInterruptedFiber(name: string, snapshot?: unknown): Promise<void>;
  triggerFiberRecovery(): Promise<void>;
  persistMessages(messages: unknown[]): Promise<void>;
  runRecoveryRetryForTest(options?: {
    targetUserId?: string;
    lastBody?: Record<string, unknown>;
  }): Promise<void>;
  runScheduledRecoveryRetryForTest(): Promise<void>;
  runScheduledRecoveryContinueForTest(): Promise<void>;
  setRequestContextForTest(
    body?: Record<string, unknown>,
    clientTools?: Array<{ name: string; description?: string }>
  ): Promise<void>;
  getOnChatMessageBodies(): Promise<Array<Record<string, unknown> | undefined>>;
  getOnChatMessageClientTools(): Promise<
    Array<Array<{ name: string; description?: string }> | undefined>
  >;
  getScheduleCountForCallback(callback: string): Promise<number>;
  getRunFiberCountForTest(): Promise<number>;
  runAlarmForTest(): Promise<void>;
  setSimulateSupersededIsolateForTest(value: boolean): Promise<void>;
  getSupersededThrowsForTest(): Promise<number>;
  setChatRecoveryConfigForTest(config: {
    maxAttempts?: number;
    terminalMessage?: string;
  }): Promise<void>;
  getChatRecoveryIncidentsForTest(): Promise<unknown[]>;
  addAssistantMessageForTest(id: string): Promise<void>;
  bumpRecoveryProgressForTest(): Promise<void>;
  dropAssistantMessagesForTest(): Promise<void>;
  setRecoveryShouldThrowForTest(shouldThrow: boolean): Promise<void>;
  enableThrowingOnExhaustedForTest(
    maxAttempts: number,
    terminalMessage: string
  ): Promise<void>;
  getOnExhaustedCallsForTest(): Promise<number>;
  beginIncidentForTest(input: {
    requestId: string;
    recoveryRootRequestId?: string | null;
    latestUserMessageId?: string | null;
    recoveryKind: "retry" | "continue";
  }): Promise<{ incidentId: string; attempt: number; exhausted: boolean }>;
  updateIncidentForTest(
    incidentId: string,
    status: string,
    reason?: string
  ): Promise<void>;
  seedIncidentForTest(incident: {
    incidentId: string;
    requestId: string;
    recoveryKind: "retry" | "continue";
    attempt: number;
    maxAttempts: number;
    status: string;
    firstSeenAt: number;
    lastAttemptAt: number;
  }): Promise<void>;
  setForceStableTimeoutForTest(value: boolean): Promise<void>;
  runChatRecoveryContinueDirectForTest(
    data: Record<string, unknown>
  ): Promise<void>;
  preScheduleRecoveryContinueForTest(
    data: Record<string, unknown>
  ): Promise<void>;
  getIncidentForTest(incidentId: string): Promise<{
    attempt: number;
    status: string;
    reason?: string;
  } | null>;
}

async function getTestAgent(room: string): Promise<ChatRecoveryTestStub> {
  const stub = await getAgentByName(env.ChatRecoveryTestAgent, room);
  return stub as unknown as ChatRecoveryTestStub;
}

describe("onChatRecovery", () => {
  function makeChunks(
    texts: string[],
    messageId?: string
  ): Array<{ body: string; index: number }> {
    const chunks: Array<{ body: string; index: number }> = [];
    let i = 0;
    if (messageId) {
      chunks.push({
        body: JSON.stringify({ type: "start", messageId }),
        index: i++
      });
    }
    chunks.push({ body: JSON.stringify({ type: "text-start" }), index: i++ });
    for (const text of texts) {
      chunks.push({
        body: JSON.stringify({ type: "text-delta", delta: text }),
        index: i++
      });
    }
    return chunks;
  }

  it("should fire onChatRecovery for an orphaned stream", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    // Disable continuation for this test (just check the hook fires)
    await agentStub.setRecoveryOverride({ continue: false });

    await agentStub.insertInterruptedStream(
      "stream-1",
      "req-1",
      makeChunks(["Hello ", "world"])
    );
    await agentStub.triggerInterruptedStreamCheck();

    const contexts = (await agentStub.getRecoveryContexts()) as Array<{
      streamId: string;
      requestId: string;
      partialText: string;
    }>;

    expect(contexts).toHaveLength(1);
    expect(contexts[0].streamId).toBe("stream-1");
    expect(contexts[0].requestId).toBe("req-1");
    expect(contexts[0].partialText).toBe("Hello world");
  });

  it("should fire onChatRecovery for stale streams (>5min)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.setRecoveryOverride({ continue: false });

    const ageMs = 10 * 60 * 1000;
    await agentStub.insertInterruptedStream(
      "stream-stale",
      "req-stale",
      makeChunks(["Stale content"]),
      ageMs
    );
    await agentStub.triggerInterruptedStreamCheck();

    const contexts = (await agentStub.getRecoveryContexts()) as Array<{
      streamId: string;
      partialText: string;
      createdAt: number;
    }>;

    expect(contexts).toHaveLength(1);
    expect(contexts[0].partialText).toBe("Stale content");
    expect(typeof contexts[0].createdAt).toBe("number");
    // createdAt reflects the back-dated stream age so apps can gate on it.
    expect(Date.now() - contexts[0].createdAt).toBeGreaterThanOrEqual(
      ageMs - 1000
    );
  });

  it("should expose createdAt on the recovery context for fiber recovery", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.setRecoveryOverride({ continue: false });

    const before = Date.now();
    await agentStub.insertInterruptedStream(
      "stream-createdat",
      "req-createdat",
      makeChunks(["Hi"])
    );
    await agentStub.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-createdat"
    );
    await agentStub.triggerFiberRecovery();

    const contexts = (await agentStub.getRecoveryContexts()) as Array<{
      requestId: string;
      createdAt: number;
    }>;
    const match = contexts.find((c) => c.requestId === "req-createdat");
    expect(match).toBeDefined();
    expect(typeof match!.createdAt).toBe("number");
    expect(match!.createdAt).toBeGreaterThanOrEqual(before);
    expect(match!.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it("passes incident metadata and exhausts after maxAttempts", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.setChatRecoveryConfigForTest({
      maxAttempts: 1,
      terminalMessage: "gave up"
    });
    await agentStub.setRecoveryOverride({ continue: false });

    await agentStub.insertInterruptedFiber("__cf_internal_chat_turn:req-cap");
    await agentStub.triggerFiberRecovery();

    const contexts = (await agentStub.getRecoveryContexts()) as Array<{
      incidentId: string;
      attempt: number;
      maxAttempts: number;
      recoveryKind: string;
    }>;
    expect(contexts.at(-1)).toMatchObject({
      incidentId: "req-cap:",
      attempt: 1,
      maxAttempts: 1,
      recoveryKind: "continue"
    });

    await agentStub.insertInterruptedFiber("__cf_internal_chat_turn:req-cap");
    await agentStub.triggerFiberRecovery();

    const incidents =
      (await agentStub.getChatRecoveryIncidentsForTest()) as Array<{
        attempt: number;
        maxAttempts: number;
        status: string;
        reason?: string;
      }>;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      attempt: 2,
      maxAttempts: 1,
      status: "exhausted",
      reason: "max_attempts_exceeded"
    });
  });

  it("resets the attempt budget when recovery makes forward progress", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    const input = {
      requestId: "req-prog",
      recoveryRootRequestId: "req-prog",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };

    // Two consecutive detections with no progress climb toward the cap.
    expect((await agentStub.beginIncidentForTest(input)).attempt).toBe(1);
    expect((await agentStub.beginIncidentForTest(input)).attempt).toBe(2);

    // Forward progress (the durable counter advances, as `_persistOrphanedStream`
    // does after materializing a partial) resets the budget — the deploy-churn fix.
    await agentStub.bumpRecoveryProgressForTest();
    const afterProgress = await agentStub.beginIncidentForTest(input);
    expect(afterProgress.attempt).toBe(1);
    expect(afterProgress.exhausted).toBe(false);

    // Without further progress it climbs again and still exhausts at the cap.
    expect((await agentStub.beginIncidentForTest(input)).attempt).toBe(2);
    const exhausted = await agentStub.beginIncidentForTest(input);
    expect(exhausted.attempt).toBe(3);
    expect(exhausted.exhausted).toBe(true);
  });

  it("detects forward progress even after compaction collapses the transcript (#1628)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    const input = {
      requestId: "req-compact",
      recoveryRootRequestId: "req-compact",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };

    // First detection opens the incident.
    expect((await agentStub.beginIncidentForTest(input)).attempt).toBe(1);

    // The turn advances (a partial is materialized) AND compaction then
    // collapses every assistant message out of the live transcript. The old
    // message-count marker would now read FEWER messages than the previous
    // attempt and miss the progress; the durable counter is immune.
    await agentStub.bumpRecoveryProgressForTest();
    await agentStub.dropAssistantMessagesForTest();

    const afterProgress = await agentStub.beginIncidentForTest(input);
    expect(afterProgress.attempt).toBe(1);
    expect(afterProgress.exhausted).toBe(false);
  });

  it("exhausts via the wall-clock window even while making progress", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setChatRecoveryConfigForTest({ maxAttempts: 6 });

    // An incident that opened more than the 15-minute window ago.
    await agentStub.seedIncidentForTest({
      incidentId: "req-old:u1",
      requestId: "req-old",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now() - 16 * 60 * 1000,
      lastAttemptAt: Date.now() - 1000
    });

    // Even with fresh progress, the wall-clock ceiling terminalizes it.
    await agentStub.bumpRecoveryProgressForTest();
    const next = await agentStub.beginIncidentForTest({
      requestId: "req-old-2",
      recoveryRootRequestId: "req-old",
      latestUserMessageId: "u1",
      recoveryKind: "continue"
    });
    expect(next.exhausted).toBe(true);

    const incidents =
      (await agentStub.getChatRecoveryIncidentsForTest()) as Array<{
        status: string;
        reason?: string;
      }>;
    expect(incidents[0]).toMatchObject({
      status: "exhausted",
      reason: "max_recovery_window_exceeded"
    });
  });

  it("recovers when the continuation alarm fires on a superseded isolate", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    // Simulate a SUPERSEDED isolate before recovery schedules anything, so
    // every run of the continuation throws the catchable "Durable Object reset
    // because its code was updated." — no race with the real DO alarm.
    await agentStub.setSimulateSupersededIsolateForTest(true);

    // Interrupted chat turn: recovery schedules the continuation and, because
    // recovery is "handled", deletes the orphaned fiber-ledger row. From here
    // the only thing that can resume the turn is the scheduled continuation.
    await agentStub.insertInterruptedFiber("__cf_internal_chat_turn:req-stale");
    await agentStub.triggerFiberRecovery();
    expect(await agentStub.getRunFiberCountForTest()).toBe(0);

    // Fire the continuation alarm on the superseded isolate. The first storage
    // op throws for the whole invocation; `_executeScheduleCallback` would burn
    // its in-process retries and (pre-fix) swallow the error, letting `alarm()`
    // delete the one-shot row.
    await agentStub.runAlarmForTest();
    expect(await agentStub.getSupersededThrowsForTest()).toBeGreaterThanOrEqual(
      1
    );

    // A deploy-class transient must not destroy recovery: the turn should still
    // be resumable afterward — either the one-shot continuation row survives for
    // a fresh-code re-run, or an orphaned fiber remains for the boot scan. On
    // current main BOTH are gone, so this fails — that is the bug (the turn is
    // permanently abandoned; #1615's progress logic never runs again).
    const pendingContinuations = await agentStub.getScheduleCountForCallback(
      "_chatRecoveryContinue"
    );
    const pendingFibers = await agentStub.getRunFiberCountForTest();
    expect(pendingContinuations + pendingFibers).toBeGreaterThanOrEqual(1);

    // Stop simulating so any platform-retried alarm can complete cleanly.
    await agentStub.setSimulateSupersededIsolateForTest(false);
  });

  it("shares one attempt budget when an incident flips between retry and continue", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    const first = await agentStub.beginIncidentForTest({
      requestId: "req-flip",
      recoveryRootRequestId: "req-flip",
      latestUserMessageId: "user-flip",
      recoveryKind: "retry"
    });
    const second = await agentStub.beginIncidentForTest({
      requestId: "req-flip-2",
      recoveryRootRequestId: "req-flip",
      latestUserMessageId: "user-flip",
      recoveryKind: "continue"
    });

    expect(first.incidentId).toBe("req-flip:user-flip");
    expect(second.incidentId).toBe("req-flip:user-flip");
    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
    expect(await agentStub.getChatRecoveryIncidentsForTest()).toHaveLength(1);
  });

  it("deletes the incident record once recovery completes", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    const incident = await agentStub.beginIncidentForTest({
      requestId: "req-done",
      recoveryRootRequestId: "req-done",
      latestUserMessageId: "user-done",
      recoveryKind: "continue"
    });
    expect(await agentStub.getChatRecoveryIncidentsForTest()).toHaveLength(1);

    await agentStub.updateIncidentForTest(incident.incidentId, "completed");
    expect(await agentStub.getChatRecoveryIncidentsForTest()).toHaveLength(0);
  });

  it("sweeps incidents inactive past the TTL on the next incident", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    const staleAt = Date.now() - 2 * 60 * 60 * 1000;
    await agentStub.seedIncidentForTest({
      incidentId: "stale:user",
      requestId: "stale",
      recoveryKind: "continue",
      attempt: 3,
      maxAttempts: 6,
      status: "failed",
      firstSeenAt: staleAt,
      lastAttemptAt: staleAt
    });
    expect(await agentStub.getChatRecoveryIncidentsForTest()).toHaveLength(1);

    await agentStub.beginIncidentForTest({
      requestId: "req-fresh",
      recoveryRootRequestId: "req-fresh",
      latestUserMessageId: "user-fresh",
      recoveryKind: "continue"
    });

    const incidents =
      (await agentStub.getChatRecoveryIncidentsForTest()) as Array<{
        incidentId: string;
      }>;
    expect(incidents).toHaveLength(1);
    expect(incidents[0].incidentId).toBe("req-fresh:user-fresh");
  });

  it("marks the incident failed when onChatRecovery throws", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.setRecoveryShouldThrowForTest(true);

    const failed: string[] = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:recovery:failed") {
        failed.push(event.payload.incidentId);
      }
    });

    try {
      await agentStub.insertInterruptedFiber(
        "__cf_internal_chat_turn:req-throw"
      );
      await agentStub.triggerFiberRecovery();
    } finally {
      unsubscribe();
    }

    const incidents =
      (await agentStub.getChatRecoveryIncidentsForTest()) as Array<{
        status: string;
        reason?: string;
      }>;
    expect(incidents).toHaveLength(1);
    expect(incidents[0].status).toBe("failed");
    expect(incidents[0].reason).toContain("onChatRecovery boom");
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });

  it("still delivers terminal UX when onExhausted throws", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.enableThrowingOnExhaustedForTest(1, "gave up");
    await agentStub.setRecoveryOverride({ continue: false });

    const fiberFailures: string[] = [];
    const unsubscribe = subscribe("fiber", (event) => {
      if (event.type === "fiber:recovery:failed") {
        fiberFailures.push(event.payload.fiberId);
      }
    });

    try {
      await agentStub.insertInterruptedFiber(
        "__cf_internal_chat_turn:req-ex-throw"
      );
      await agentStub.triggerFiberRecovery();
      await agentStub.insertInterruptedFiber(
        "__cf_internal_chat_turn:req-ex-throw"
      );
      await agentStub.triggerFiberRecovery();
    } finally {
      unsubscribe();
    }

    expect(await agentStub.getOnExhaustedCallsForTest()).toBe(1);
    expect(fiberFailures).toHaveLength(0);

    const incidents =
      (await agentStub.getChatRecoveryIncidentsForTest()) as Array<{
        status: string;
      }>;
    expect(incidents).toHaveLength(1);
    expect(incidents[0].status).toBe("exhausted");
  });

  it("should persist partial by default (persist !== false)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.setRecoveryOverride({ continue: false });

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      }
    ] as ChatMessage[]);

    await agentStub.insertInterruptedStream(
      "stream-persist",
      "req-persist",
      makeChunks(["Partial response"], "assistant-persist")
    );
    await agentStub.triggerInterruptedStreamCheck();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter(
      (m: ChatMessage) => m.role === "assistant"
    );

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].id).toBe("assistant-persist");
  });

  it("should skip persistence when persist: false", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.setRecoveryOverride({
      persist: false,
      continue: false
    });

    await agentStub.insertInterruptedStream(
      "stream-no-persist",
      "req-no-persist",
      makeChunks(["Should not be saved"])
    );
    await agentStub.triggerInterruptedStreamCheck();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter(
      (m: ChatMessage) => m.role === "assistant"
    );

    expect(assistantMessages).toHaveLength(0);
  });

  it("should not fire hook again after cleanup", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.setRecoveryOverride({ continue: false });

    await agentStub.insertInterruptedStream(
      "stream-once",
      "req-once",
      makeChunks(["Once"])
    );
    await agentStub.triggerInterruptedStreamCheck();
    await agentStub.triggerInterruptedStreamCheck();

    const contexts = (await agentStub.getRecoveryContexts()) as Array<{
      streamId: string;
    }>;
    expect(contexts).toHaveLength(1);
  });

  it("should extract partial text from stored chunks", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.insertInterruptedStream(
      "stream-text",
      "req-text",
      makeChunks(["First ", "second ", "third"])
    );

    const result = (await agentStub.getPartialText("stream-text")) as {
      text: string;
      parts: unknown[];
    };

    expect(result.text).toBe("First second third");
    expect(result.parts).toHaveLength(1);
  });

  it("should return empty when no stream exists", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    const result = (await agentStub.getPartialText()) as {
      text: string;
      parts: unknown[];
    };

    expect(result.text).toBe("");
    expect(result.parts).toEqual([]);
  });

  it("should return default options ({}) from onChatRecovery", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    // Don't set an override — use default behavior
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      }
    ] as ChatMessage[]);

    await agentStub.insertInterruptedStream(
      "stream-default",
      "req-default",
      makeChunks(["Default behavior"], "assistant-default")
    );
    await agentStub.triggerInterruptedStreamCheck();
    await agentStub.waitForIdleForTest();

    // Default: persist = true → partial should be saved
    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter(
      (m: ChatMessage) => m.role === "assistant"
    );
    expect(assistantMessages).toHaveLength(1);

    // Default: continue = true → onChatMessage should have been called
    const callCount =
      (await agentStub.getOnChatMessageCallCount()) as unknown as number;
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  // ── Fiber-based recovery (via runFiber system) ────────────────

  it("should recover a chat fiber via _handleInternalFiberRecovery", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setRecoveryOverride({ continue: false });

    // Pre-populate a user message
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      }
    ] as ChatMessage[]);

    // Insert stream chunks first
    await agentStub.insertInterruptedStream(
      "stream-fiber",
      "req-fiber",
      makeChunks(["Fiber recovery text"], "assistant-fiber")
    );

    // Insert a fiber row — name encodes requestId after the prefix
    await agentStub.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-fiber",
      { someUserData: true }
    );

    // Trigger fiber-based recovery (not the old stream-based one)
    await agentStub.triggerFiberRecovery();

    // onChatRecovery should have been called via _handleInternalFiberRecovery
    const contexts = (await agentStub.getRecoveryContexts()) as Array<{
      streamId: string;
      partialText: string;
      recoveryData: unknown;
    }>;

    expect(contexts.length).toBeGreaterThanOrEqual(1);
    const fiberCtx = contexts[contexts.length - 1];
    expect(fiberCtx.streamId).toBe("stream-fiber");
    expect(fiberCtx.partialText).toBe("Fiber recovery text");
    expect(fiberCtx.recoveryData).toEqual({ someUserData: true });
  });

  it("should retry a pre-stream interrupted user turn by default", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.persistMessages([
      {
        id: "user-retry",
        role: "user",
        parts: [{ type: "text", text: "Retry this unanswered message" }]
      }
    ] as ChatMessage[]);

    await agentStub.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-retry",
      {
        __cfAIChatFiberSnapshot: {
          kind: "ai-chat-turn",
          version: 1,
          requestId: "req-retry",
          continuation: false,
          latestMessageId: "user-retry",
          latestMessageRole: "user",
          latestUserMessageId: "user-retry",
          startedAt: Date.now(),
          lastBody: { mode: "snapshot" }
        },
        user: { responseId: "pre-stream" }
      }
    );

    await agentStub.triggerFiberRecovery();
    const retryScheduleCount =
      await agentStub.getScheduleCountForCallback("_chatRecoveryRetry");
    if (retryScheduleCount > 0) {
      await agentStub.runScheduledRecoveryRetryForTest();
    }
    await agentStub.waitForIdleForTest();

    const contexts = (await agentStub.getRecoveryContexts()) as Array<{
      streamId: string;
      partialText: string;
      recoveryData: unknown;
      lastBody?: Record<string, unknown>;
    }>;
    const ctx = contexts[contexts.length - 1];
    expect(ctx.streamId).toBe("");
    expect(ctx.partialText).toBe("");
    expect(ctx.recoveryData).toEqual({ responseId: "pre-stream" });
    expect(ctx.lastBody).toEqual({ mode: "snapshot" });

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(messages[0].id).toBe("user-retry");
    expect(await agentStub.getOnChatMessageBodies()).toEqual([
      { mode: "snapshot" }
    ]);
  });

  it("should continue a partial stream with request context from the recovered snapshot", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.persistMessages([
      {
        id: "user-continue",
        role: "user",
        parts: [{ type: "text", text: "Continue this partial answer" }]
      }
    ] as ChatMessage[]);

    await agentStub.insertInterruptedStream(
      "stream-continue",
      "req-continue",
      makeChunks(["Partial answer"], "assistant-continue")
    );
    await agentStub.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-continue",
      {
        __cfAIChatFiberSnapshot: {
          kind: "ai-chat-turn",
          version: 1,
          requestId: "req-continue",
          continuation: false,
          latestMessageId: "user-continue",
          latestMessageRole: "user",
          latestUserMessageId: "user-continue",
          startedAt: Date.now(),
          lastBody: { mode: "snapshot" },
          lastClientTools: [{ name: "snapshotTool", description: "Snapshot" }]
        },
        user: null
      }
    );

    await agentStub.triggerFiberRecovery();
    const continueScheduleCount = await agentStub.getScheduleCountForCallback(
      "_chatRecoveryContinue"
    );

    await agentStub.setRequestContextForTest({ mode: "stale" }, [
      { name: "staleTool", description: "Stale" }
    ]);
    if (continueScheduleCount > 0) {
      await agentStub.runScheduledRecoveryContinueForTest();
    }
    await agentStub.waitForIdleForTest();

    expect(await agentStub.getOnChatMessageBodies()).toEqual([
      { mode: "snapshot" }
    ]);
    expect(await agentStub.getOnChatMessageClientTools()).toEqual([
      [{ name: "snapshotTool", description: "Snapshot" }]
    ]);
  });

  it("should not double-recover when _checkRunFibers runs from both onStart and alarm", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setRecoveryOverride({ continue: false });

    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      }
    ] as ChatMessage[]);

    await agentStub.insertInterruptedStream(
      "stream-double",
      "req-double",
      makeChunks(["Double recovery text"], "assistant-double")
    );
    await agentStub.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-double"
    );

    // First call (simulates onStart path)
    await agentStub.triggerFiberRecovery();

    // Second call (simulates alarm path — should be a no-op since
    // the fiber row was deleted after the first recovery)
    await agentStub.triggerFiberRecovery();

    const contexts = (await agentStub.getRecoveryContexts()) as Array<{
      streamId: string;
      partialText: string;
    }>;

    // Recovery should have fired exactly once, not twice
    const doubleContexts = contexts.filter(
      (c) => c.streamId === "stream-double"
    );
    expect(doubleContexts).toHaveLength(1);
    expect(doubleContexts[0].partialText).toBe("Double recovery text");

    // Message should be persisted once (not duplicated)
    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter(
      (m: ChatMessage) => m.role === "assistant"
    );
    expect(assistantMessages).toHaveLength(1);
  });

  it("reschedules a continuation that times out waiting for stable state, within the attempt budget", async () => {
    const agentStub = await getTestAgent(`stable-retry-${crypto.randomUUID()}`);
    await agentStub.setForceStableTimeoutForTest(true);
    await agentStub.seedIncidentForTest({
      incidentId: "inc-retry",
      requestId: "root-retry",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    const continueData = {
      incidentId: "inc-retry",
      originalRequestId: "root-retry",
      targetAssistantId: "a-x"
    };
    // Simulate the executing one-shot row that `alarm()` deletes after return.
    await agentStub.preScheduleRecoveryContinueForTest(continueData);

    await agentStub.runChatRecoveryContinueDirectForTest(continueData);

    // The reschedule must create a NEW row (2 total), not dedup onto the
    // executing one — otherwise the retry silently never fires.
    expect(
      await agentStub.getScheduleCountForCallback("_chatRecoveryContinue")
    ).toBe(2);
    const incident = await agentStub.getIncidentForTest("inc-retry");
    expect(incident?.attempt).toBe(2);
    expect(incident?.status).toBe("scheduled");
  });

  it("fails terminally once the stable-state retry budget is exhausted", async () => {
    const agentStub = await getTestAgent(
      `stable-exhaust-${crypto.randomUUID()}`
    );
    await agentStub.setForceStableTimeoutForTest(true);
    await agentStub.seedIncidentForTest({
      incidentId: "inc-exhaust",
      requestId: "root-exhaust",
      recoveryKind: "continue",
      attempt: 6,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    await agentStub.runChatRecoveryContinueDirectForTest({
      incidentId: "inc-exhaust",
      originalRequestId: "root-exhaust",
      targetAssistantId: "a-x"
    });

    expect(
      await agentStub.getScheduleCountForCallback("_chatRecoveryContinue")
    ).toBe(0);
    const incident = await agentStub.getIncidentForTest("inc-exhaust");
    expect(incident?.status).toBe("failed");
    expect(incident?.reason).toBe("stable_timeout");
  });
});
