import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { getAgentByName } from "agents";
import { subscribe } from "agents/observability";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS, socketBarrier } from "./test-utils";
import { MessageType } from "../types";

/** Every frame `ws` receives from now on, parsed. */
function seenFrames(ws: WebSocket): unknown[] {
  const frames: unknown[] = [];
  ws.addEventListener("message", (e) => {
    frames.push(JSON.parse(e.data as string));
  });
  return frames;
}

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
    ageMs?: number,
    metadata?: { messageId?: string; continuation?: boolean }
  ): Promise<void>;
  insertInterruptedFiber(name: string, snapshot?: unknown): Promise<void>;
  insertInterruptedLaneTurn(
    requestId: string,
    began: boolean,
    stash?: unknown
  ): Promise<void>;
  getActiveFibers(): Promise<Array<{ id: string; name: string }>>;
  openChatTurnRunsForTest(): Promise<number>;
  armTransientInRecoveryForTest(throwsBeforeHandoff?: number): Promise<void>;
  throwsBeforeHandoffLeftForTest(): Promise<number>;
  openAttemptRunsForTest(): Promise<string[]>;
  runOpenAttemptRunsForTest(): Promise<void>;
  armFailingReaderTurnForTest(
    message: string,
    prelude: "partial"
  ): Promise<void>;
  insertLegacyChatFiberForTest(
    requestId: string,
    snapshot?: unknown
  ): Promise<void>;
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
  getRecoveryTransportCountsForTest(
    callback: string
  ): Promise<{ tasks: number; schedules: number }>;
  testRecoveryDispatchHandoffForTest(options: {
    callback: "_chatRecoveryContinue" | "_chatRecoveryRetry";
    phase: "before" | "after";
  }): Promise<{ threw: boolean; tasks: number; schedules: number }>;
  getRunFiberCountForTest(): Promise<number>;
  runAlarmForTest(): Promise<void>;
  setSimulateSupersededIsolateForTest(value: boolean): Promise<void>;
  setSimulateTransientErrorForTest(message: string | null): Promise<void>;
  getSupersededThrowsForTest(): Promise<number>;
  testStableTimeoutSealTransientDefer(input: {
    transientMessage: string;
    terminalMessage: string;
  }): Promise<{
    firstThrew: boolean;
    incidentStatusAfterFirst: string | undefined;
    secondThrew: boolean;
    incidentStatusAfterSecond: string | undefined;
    terminalBroadcast: string | undefined;
    exhaustedReasons: string[];
  }>;
  testStableTimeoutIncidentReadBestEffort(input: {
    transientMessage: string;
    terminalMessage: string;
  }): Promise<{
    threw: boolean;
    terminalBroadcast: string | undefined;
    exhaustedReasons: string[];
    incidentStatus: string | undefined;
  }>;
  testStableTimeoutSealWriteBestEffort(input: {
    transientMessage: string;
    terminalMessage: string;
  }): Promise<{
    threw: boolean;
    terminalBroadcast: string | undefined;
    exhaustedReasons: string[];
    incidentStatus: string | undefined;
  }>;
  setChatRecoveryConfigForTest(config: {
    maxAttempts?: number;
    terminalMessage?: string;
    maxRecoveryWork?: number;
    noProgressTimeoutMs?: number;
  }): Promise<void>;
  setShouldKeepRecoveringForTest(keepRecovering: boolean): Promise<void>;
  getChatRecoveryIncidentsForTest(): Promise<unknown[]>;
  holdNextTurnForTest(): Promise<void>;
  holdStableWaitForTest(): Promise<void>;
  abortAllRequestsForTest(): Promise<void>;
  isStableWaitHeldForTest(): Promise<boolean>;
  heldTurnRequestIdForTest(): Promise<string | null>;
  setStableWaitErrorForTest(message: string | null): Promise<void>;
  releaseStableWaitForTest(): Promise<void>;
  isTurnHeldForTest(): Promise<boolean>;
  releaseHeldTurnForTest(): Promise<void>;
  addAssistantMessageForTest(id: string): Promise<void>;
  bumpRecoveryProgressForTest(): Promise<void>;
  forwardChildStreamProgressForTest(
    chunks: number
  ): Promise<{ start: number; after: number }>;
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
    nowMs?: number;
  }): Promise<{
    incidentId: string;
    attempt: number;
    exhausted: boolean;
    reason?: string;
  }>;
  ageIncidentForTest(incidentId: string, ms: number): Promise<void>;
  probeProgressReconnectImmunityForTest(): Promise<{
    start: number;
    afterFlush: number;
    afterPersist: number;
  }>;
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
    lastProgressAt?: number;
    progress?: number;
    workBaseline?: number;
    interruptedAttempts?: number;
    recoveryRootRequestId?: string;
    scheduleCount?: number;
    scheduled?: {
      callback: "_chatRecoveryContinue" | "_chatRecoveryRetry";
      targetMessageId?: string;
    };
  }): Promise<void>;
  setForceStableTimeoutForTest(value: boolean): Promise<void>;
  setPendingClientInteractionForTest(value: boolean | null): Promise<void>;
  setRequestContextForTest(
    body: Record<string, unknown> | undefined,
    clientTools: Array<{ name: string }>
  ): Promise<void>;
  persistPendingToolCallForTest(
    messageId: string,
    toolName: string,
    options?: { cutOff?: boolean }
  ): Promise<void>;
  runChatRecoveryContinueDirectForTest(
    data: Record<string, unknown>
  ): Promise<void>;
  runChatRecoveryRetryDirectForTest(
    data: Record<string, unknown>
  ): Promise<void>;
  seedReleasedRecoveryRunForTest(
    callback: "_chatRecoveryContinue" | "_chatRecoveryRetry",
    data: Record<string, unknown>,
    delaySeconds: number
  ): Promise<void>;
  openReleasedRecoveryRunsForTest(): Promise<number>;
  startAttemptRunForTest(
    callback: "_chatRecoveryContinue" | "_chatRecoveryRetry",
    data: Record<string, unknown>,
    delaySeconds: number
  ): Promise<void>;
  recoveryRunStepsForTest(): Promise<string[]>;
  preScheduleRecoveryContinueForTest(
    data: Record<string, unknown>
  ): Promise<void>;
  preScheduleRecoveryRetryForTest(data: Record<string, unknown>): Promise<void>;
  getIncidentForTest(incidentId: string): Promise<{
    attempt: number;
    status: string;
    reason?: string;
  } | null>;
  getChatRecoveringForTest(): Promise<{ requestId?: string } | null>;
  getRecoveringConnectFrameForTest(): Promise<Record<string, unknown> | null>;
  enableExhaustedCaptureForTest(
    maxAttempts: number,
    terminalMessage?: string
  ): Promise<void>;
  getExhaustedContextsForTest(): Promise<
    Array<{
      recoveryRootRequestId: string;
      recoveryKind: "retry" | "continue";
      reason: string;
      terminalMessage: string;
    }>
  >;
  chatTurnRunsInFlightForTest(): Promise<number>;
  backingOffChatTurnRunsForTest(): Promise<number>;
  isChatResponseDrainIdleForTest(): Promise<boolean>;
  getPendingChatTerminalForTest(): Promise<{
    requestId: string;
    body: string;
  } | null>;
  driveSuccessfulTurnForTest(): Promise<
    "completed" | "error" | "aborted" | "skipped"
  >;
  driveAbortedTurnForTest(when?: "before" | "after-store"): Promise<{
    status: "completed" | "error" | "aborted" | "skipped";
    userTexts: string[];
    chatCalls: number;
  }>;
  driveErroredTurnForTest(
    message: string
  ): Promise<"completed" | "error" | "aborted" | "skipped">;
  setChatStreamStallTimeoutForTest(ms: number): Promise<void>;
  stopWhileStallRoutedForTest(): Promise<{
    outcomes: string[];
    streamOpen: boolean;
    status: string;
  }>;
  driveStallingTurnForTest(options?: {
    timeoutMs?: number;
    hangTurns?: number;
  }): Promise<"completed" | "error" | "aborted" | "skipped">;
  driveStreamTextProviderErrorForTest(
    statusCode: number,
    rethrow: boolean
  ): Promise<string>;
  driveFailingReaderTurnForTest(
    message: string,
    turns?: number,
    options?: {
      prelude?: "partial" | "approval" | "start-only" | "none";
      priorAssistant?: boolean;
      responseHeaders?: Record<string, string>;
      statusCode?: number;
    }
  ): Promise<"completed" | "error" | "aborted" | "skipped">;
  getScheduledRecoveryDelayForTest(): Promise<number | null>;
  endRecoveryBackoffsForTest(): Promise<number>;
  backingOffChatTurnRunsForTest(): Promise<number>;
  driveFailingReaderTurnThenStopForTest(
    message: string,
    options?: { responseHeaders?: Record<string, string> }
  ): Promise<{
    status: "completed" | "error" | "aborted" | "skipped";
    requestId: string;
    backingOffAtStop: number;
  }>;
  getFailingReaderCallsForTest(): Promise<number>;
  startFailingReaderTurnForTest(
    message: string,
    turns: number,
    options?: {
      responseHeaders?: Record<string, string>;
      waitsAtLeastMs?: number;
    }
  ): Promise<string>;
  startedFailingTurnStatusForTest(): Promise<string>;
  endedRequestIdsForTest(): Promise<string[]>;
  endRetryWaitsForTest(): Promise<number>;
  openChatLaneRunsForTest(): Promise<number>;
  setStashData(data: unknown): Promise<void>;
  trackRecoveryTaskKeysForTest(): Promise<void>;
  getRecoveryTaskKeyedForTest(): Promise<boolean[]>;
  failNextIncidentBeginForTest(): Promise<void>;
  simulateDeadAttemptForTest(incidentId: string): Promise<void>;
  runRecoveryCallbackForTest(
    callback: "_chatRecoveryContinue" | "_chatRecoveryRetry",
    data: Record<string, unknown>
  ): Promise<void>;
}

async function getTestAgent(room: string): Promise<ChatRecoveryTestStub> {
  const stub = await getAgentByName(env.ChatRecoveryTestAgent, room);
  return stub as unknown as ChatRecoveryTestStub;
}

/**
 * A failure whose recovery waits a minute before it runs: the provider's
 * `retry-after` is believed. A test that acts during a recovery's backoff
 * uses it so the backoff cannot end by itself, and ends it with
 * `endRecoveryBackoffsForTest()` when the recovery is to run.
 */
const HELD_BACKOFF = { responseHeaders: { "retry-after": "60" } };

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

  it("recovers a chat turn's fiber row an older version left", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.setRecoveryOverride({ continue: false });
    await agentStub.insertInterruptedStream(
      "stream-legacy",
      "req-legacy",
      makeChunks(["Hi"])
    );
    await agentStub.insertLegacyChatFiberForTest("req-legacy");
    await agentStub.triggerFiberRecovery();

    const contexts = (await agentStub.getRecoveryContexts()) as Array<{
      requestId: string;
      partialText: string;
    }>;
    expect(contexts).toEqual([
      expect.objectContaining({ requestId: "req-legacy", partialText: "Hi" })
    ]);
    expect(await agentStub.getRunFiberCountForTest()).toBe(0);
  });

  it("does not carry a turn an earlier version left cut off when the conversation moved on", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    // A newer question is the latest message: there is no reply of this
    // turn's to continue and no question of its own to answer again.
    await agentStub.persistMessages([
      { id: "u-old", role: "user", parts: [{ type: "text", text: "Hi" }] },
      {
        id: "a-old",
        role: "assistant",
        parts: [{ type: "text", text: "Hey" }]
      },
      { id: "u-new", role: "user", parts: [{ type: "text", text: "And?" }] }
    ]);
    await agentStub.insertInterruptedFiber("__cf_internal_chat_turn:req-moved");
    await agentStub.triggerFiberRecovery();

    // The turn is not carried: no run is started for it and the model is
    // not asked. The newer question's own turn answers it.
    expect(await agentStub.openChatLaneRunsForTest()).toBe(0);
    expect(await agentStub.getOnChatMessageCallCount()).toBe(0);
  });

  it("seals a recovery callback whose attempts die before starting a turn (#2613)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.enableExhaustedCaptureForTest(100);
    await agentStub.seedIncidentForTest({
      incidentId: "req-pre-turn:",
      requestId: "req-pre-turn",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 100,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now(),
      interruptedAttempts: 4
    });
    // The last callback died while it was still checking stable state, so
    // no turn run exists to replay; only its attempt record is left.
    await agentStub.simulateDeadAttemptForTest("req-pre-turn:");

    await agentStub.runRecoveryCallbackForTest("_chatRecoveryContinue", {
      incidentId: "req-pre-turn:",
      originalRequestId: "req-pre-turn"
    });

    const exhausted = await agentStub.getExhaustedContextsForTest();
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].reason).toBe("interrupted_attempts_exceeded");
    expect(await agentStub.getOnChatMessageCallCount()).toBe(0);
    const incidents =
      (await agentStub.getChatRecoveryIncidentsForTest()) as Array<{
        interruptedAttempts?: number;
        status: string;
      }>;
    expect(incidents[0]).toMatchObject({
      interruptedAttempts: 5,
      status: "exhausted"
    });
  });

  it("resets the attempt budget when recovery makes forward progress", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    const baseInput = {
      requestId: "req-prog",
      recoveryRootRequestId: "req-prog",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    // Space attempts >30s apart so alarm-debounce (#1637) doesn't collapse them.
    let t = 1_000_000;
    const at = () => {
      const nowMs = t;
      t += 40_000;
      return { ...baseInput, nowMs };
    };

    // Two debounce-spaced detections with no progress climb toward the cap.
    expect((await agentStub.beginIncidentForTest(at())).attempt).toBe(1);
    expect((await agentStub.beginIncidentForTest(at())).attempt).toBe(2);

    // Forward progress (the durable counter advances, as `_persistOrphanedStream`
    // does after materializing a partial) resets the budget — the deploy-churn fix.
    await agentStub.bumpRecoveryProgressForTest();
    const afterProgress = await agentStub.beginIncidentForTest(at());
    expect(afterProgress.attempt).toBe(1);
    expect(afterProgress.exhausted).toBe(false);

    // Without further progress it climbs again and still exhausts at the cap.
    expect((await agentStub.beginIncidentForTest(at())).attempt).toBe(2);
    const exhausted = await agentStub.beginIncidentForTest(at());
    expect(exhausted.attempt).toBe(3);
    expect(exhausted.exhausted).toBe(true);
  });

  it("credits forwarding a sub-agent's stream as parent forward progress (N9)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    const baseInput = {
      requestId: "req-n9",
      recoveryRootRequestId: "req-n9",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    let t = 1_000_000;
    const at = () => {
      const nowMs = t;
      t += 40_000;
      return { ...baseInput, nowMs };
    };

    // A parent whose turn merely awaits a sub-agent climbs toward the cap.
    expect((await agentStub.beginIncidentForTest(at())).attempt).toBe(1);
    expect((await agentStub.beginIncidentForTest(at())).attempt).toBe(2);

    // Re-attaching and forwarding the child's stream IS the parent's forward
    // progress (N9) — the durable marker advances through the real
    // `_forwardAgentToolStream` path, so the budget resets just like in-band
    // content does. Without this the deploy-churn parent exhausts while the
    // child streams healthily.
    const forwarded = await agentStub.forwardChildStreamProgressForTest(3);
    expect(forwarded.after).toBe(forwarded.start + 1);
    const afterChildStream = await agentStub.beginIncidentForTest(at());
    expect(afterChildStream.attempt).toBe(1);
    expect(afterChildStream.exhausted).toBe(false);
  });

  it("does NOT credit a silent/hung sub-agent, so the parent still exhausts (N9)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    const baseInput = {
      requestId: "req-n9-silent",
      recoveryRootRequestId: "req-n9-silent",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    let t = 2_000_000;
    const at = () => {
      const nowMs = t;
      t += 40_000;
      return { ...baseInput, nowMs };
    };

    expect((await agentStub.beginIncidentForTest(at())).attempt).toBe(1);
    expect((await agentStub.beginIncidentForTest(at())).attempt).toBe(2);

    // A re-attach where the child produces NO output forwards nothing, so the
    // parent banks no progress and the cap still binds.
    const forwarded = await agentStub.forwardChildStreamProgressForTest(0);
    expect(forwarded.after).toBe(forwarded.start);
    const exhausted = await agentStub.beginIncidentForTest(at());
    expect(exhausted.attempt).toBe(3);
    expect(exhausted.exhausted).toBe(true);
  });

  it("detects forward progress even after compaction collapses the transcript (#1628)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    const base = {
      requestId: "req-compact",
      recoveryRootRequestId: "req-compact",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };

    // First detection opens the incident.
    expect(
      (await agentStub.beginIncidentForTest({ ...base, nowMs: 1_000_000 }))
        .attempt
    ).toBe(1);

    // The turn advances (a partial is materialized) AND compaction then
    // collapses every assistant message out of the live transcript. The old
    // message-count marker would now read FEWER messages than the previous
    // attempt and miss the progress; the durable counter is immune.
    await agentStub.bumpRecoveryProgressForTest();
    await agentStub.dropAssistantMessagesForTest();

    const afterProgress = await agentStub.beginIncidentForTest({
      ...base,
      nowMs: 1_040_000
    });
    expect(afterProgress.attempt).toBe(1);
    expect(afterProgress.exhausted).toBe(false);
  });

  it("a progressing turn survives past the old wall-clock ceiling (rfc-chat-recovery-work-budget)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    // Default config: maxRecoveryWork is a generous finite backstop (10000) and
    // this turn produces ~1 work unit, so duration is never a bound here.
    await agentStub.setChatRecoveryConfigForTest({ maxAttempts: 6 });

    // An incident that opened well past the old 15-minute ceiling.
    await agentStub.seedIncidentForTest({
      incidentId: "req-old:u1",
      requestId: "req-old",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now() - 30 * 60 * 1000,
      lastAttemptAt: Date.now() - 1000
    });

    // Fresh forward progress: the turn is healthy. It must NOT be sealed —
    // wall-clock age no longer terminalizes a progressing turn.
    await agentStub.bumpRecoveryProgressForTest();
    const next = await agentStub.beginIncidentForTest({
      requestId: "req-old-2",
      recoveryRootRequestId: "req-old",
      latestUserMessageId: "u1",
      recoveryKind: "continue"
    });
    expect(next.exhausted).toBe(false);
    expect(next.attempt).toBe(1);

    const incidents =
      (await agentStub.getChatRecoveryIncidentsForTest()) as Array<{
        status: string;
        reason?: string;
      }>;
    expect(incidents[0]).toMatchObject({ status: "attempting" });
    expect(incidents[0]?.reason).toBeUndefined();
  });

  it("seals a content-emitting runaway via the work budget", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setChatRecoveryConfigForTest({
      maxAttempts: 100,
      maxRecoveryWork: 2
    });

    const base = {
      requestId: "req-runaway",
      recoveryRootRequestId: "req-runaway",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    let t = 5_000_000;
    const at = (): typeof base & { nowMs: number } => {
      const nowMs = t;
      t += 40_000;
      return { ...base, nowMs };
    };

    // Open the incident — the work baseline is captured at the current marker.
    expect((await agentStub.beginIncidentForTest(at())).attempt).toBe(1);

    // Three units of new content → work since the incident opened = 3 > budget
    // (2), even though every unit is genuine forward progress.
    await agentStub.bumpRecoveryProgressForTest();
    await agentStub.bumpRecoveryProgressForTest();
    await agentStub.bumpRecoveryProgressForTest();
    const next = await agentStub.beginIncidentForTest(at());
    expect(next.exhausted).toBe(true);
    expect(next.reason).toBe("work_budget_exceeded");
  });

  it("seals when the shouldKeepRecovering predicate returns false (recovery_aborted)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setShouldKeepRecoveringForTest(false);

    const base = {
      requestId: "req-abort",
      recoveryRootRequestId: "req-abort",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    let t = 6_000_000;
    const at = (): typeof base & { nowMs: number } => {
      const nowMs = t;
      t += 40_000;
      return { ...base, nowMs };
    };

    // First detection opens the incident (predicate isn't consulted on open).
    expect((await agentStub.beginIncidentForTest(at())).exhausted).toBe(false);

    // Next attempt — below every hard bound, so only the caller predicate fires.
    const next = await agentStub.beginIncidentForTest(at());
    expect(next.exhausted).toBe(true);
    expect(next.reason).toBe("recovery_aborted");
  });

  it("seals an incident after the no-progress window even below the attempt cap (#1637)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setChatRecoveryConfigForTest({ maxAttempts: 100 });

    const base = {
      requestId: "req-np",
      recoveryRootRequestId: "req-np",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    const t0 = 2_000_000;
    expect(
      (await agentStub.beginIncidentForTest({ ...base, nowMs: t0 })).exhausted
    ).toBe(false);

    // A later alarm past the 5-min no-progress window, no progress in between,
    // seals it even though the attempt count is far below the cap.
    const past = await agentStub.beginIncidentForTest({
      ...base,
      nowMs: t0 + 6 * 60 * 1000
    });
    expect(past.exhausted).toBe(true);
    expect(past.reason).toBe("no_progress_timeout");
  });

  it("honors a custom noProgressTimeoutMs override", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    // A tight 1-min no-progress window instead of the 5-min default.
    await agentStub.setChatRecoveryConfigForTest({
      maxAttempts: 100,
      noProgressTimeoutMs: 60_000
    });

    const base = {
      requestId: "req-np-cfg",
      recoveryRootRequestId: "req-np-cfg",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    const t0 = 8_000_000;
    expect(
      (await agentStub.beginIncidentForTest({ ...base, nowMs: t0 })).exhausted
    ).toBe(false);

    // 90s later with no progress — past the custom 1-min window (the 5-min
    // default would NOT have sealed here), so it seals on no-progress.
    const past = await agentStub.beginIncidentForTest({
      ...base,
      nowMs: t0 + 90_000
    });
    expect(past.exhausted).toBe(true);
    expect(past.reason).toBe("no_progress_timeout");
  });

  it("does NOT seal on no-progress while a CLIENT interaction is pending (HITL turn waiting on the human)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    // Tight 1-min no-progress window + low attempt cap: a stuck turn would seal.
    await agentStub.setChatRecoveryConfigForTest({
      maxAttempts: 2,
      noProgressTimeoutMs: 60_000
    });

    // Register `chooseOption` as a CLIENT tool, then persist an assistant message
    // parked on its `input-available` orphan — the SPA replays the tool-result
    // after reconnect, so the turn is waiting on the human, not stuck.
    await agentStub.setRequestContextForTest(undefined, [
      { name: "chooseOption" }
    ]);
    await agentStub.persistPendingToolCallForTest(
      "assistant-hitl",
      "chooseOption"
    );

    const base = {
      requestId: "req-hitl",
      recoveryRootRequestId: "req-hitl",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    const t0 = 6_000_000;
    expect(
      (await agentStub.beginIncidentForTest({ ...base, nowMs: t0 })).exhausted
    ).toBe(false);

    // Far past both the no-progress window AND the attempt cap, but a client
    // interaction is still pending — the turn is budget-free and must NOT seal.
    const later = await agentStub.beginIncidentForTest({
      ...base,
      nowMs: t0 + 10 * 60 * 1000
    });
    expect(later.exhausted).toBe(false);
    expect(later.reason).toBeUndefined();
  });

  it("STILL seals a dead SERVER-tool orphan on no-progress (the pending-interaction exemption is client-only)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setChatRecoveryConfigForTest({
      maxAttempts: 100,
      noProgressTimeoutMs: 60_000
    });

    // `previewTool` is NOT registered as a client tool, and the reply it is
    // in was cut off: its execute() died with the isolate. The call is
    // settled when that reply is stored, so it does NOT get the HITL
    // exemption; the turn seals normally on no-progress.
    await agentStub.setRequestContextForTest(undefined, [
      { name: "chooseOption" }
    ]);
    await agentStub.persistPendingToolCallForTest(
      "assistant-server",
      "previewTool",
      { cutOff: true }
    );

    const base = {
      requestId: "req-srv",
      recoveryRootRequestId: "req-srv",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    const t0 = 7_000_000;
    expect(
      (await agentStub.beginIncidentForTest({ ...base, nowMs: t0 })).exhausted
    ).toBe(false);
    const past = await agentStub.beginIncidentForTest({
      ...base,
      nowMs: t0 + 90_000
    });
    expect(past.exhausted).toBe(true);
    expect(past.reason).toBe("no_progress_timeout");
  });

  it("collapses a rollout's reconnect storm into one attempt via debounce (#1637)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    const base = {
      requestId: "req-db",
      recoveryRootRequestId: "req-db",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    const t0 = 3_000_000;

    expect(
      (await agentStub.beginIncidentForTest({ ...base, nowMs: t0 })).attempt
    ).toBe(1);
    // A burst within the debounce window must not advance the attempt count.
    expect(
      (await agentStub.beginIncidentForTest({ ...base, nowMs: t0 + 5_000 }))
        .attempt
    ).toBe(1);
    expect(
      (await agentStub.beginIncidentForTest({ ...base, nowMs: t0 + 20_000 }))
        .attempt
    ).toBe(1);
    // Beyond the debounce window it's a genuinely separate attempt.
    const later = await agentStub.beginIncidentForTest({
      ...base,
      nowMs: t0 + 60_000
    });
    expect(later.attempt).toBe(2);
    expect(later.exhausted).toBe(false);
  });

  it("advances progress on streamed content but not on an orphan re-persist (reconnect-immune, #1637)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    const { start, afterFlush, afterPersist } =
      await agentStub.probeProgressReconnectImmunityForTest();

    // Streaming new content advanced progress.
    expect(afterFlush).toBeGreaterThan(start);
    // Re-persisting that same content (a recovery/reconnect would) must NOT be
    // miscounted as new progress — otherwise a reconnecting client could reset
    // the no-progress window of a stuck turn forever.
    expect(afterPersist).toBe(afterFlush);
  });

  it("keeps pre-handoff failure on the current Task and replaces only post-handoff failure", async () => {
    for (const callback of [
      "_chatRecoveryContinue",
      "_chatRecoveryRetry"
    ] as const) {
      const before = await (
        await getTestAgent(`${callback}-before-${crypto.randomUUID()}`)
      ).testRecoveryDispatchHandoffForTest({ callback, phase: "before" });
      expect(before).toEqual({ threw: true, tasks: 1, schedules: 0 });

      const after = await (
        await getTestAgent(`${callback}-after-${crypto.randomUUID()}`)
      ).testRecoveryDispatchHandoffForTest({ callback, phase: "after" });
      expect(after).toEqual({ threw: false, tasks: 2, schedules: 0 });
    }
  });

  it("defers a give-up whose terminal write hits a platform transient instead of half-sealing, then seals fully on the re-run (#1730)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    const terminalMessage = "The assistant was interrupted. Please try again.";

    const result = await agentStub.testStableTimeoutSealTransientDefer({
      transientMessage: "Network connection lost.",
      terminalMessage
    });

    // First give-up: the durable terminal write (#1645) rejects mid-deploy →
    // the transient propagates (so the base scheduler preserves the one-shot
    // row) and the incident is NOT sealed — sealing first would turn the
    // deferred re-run into a no-op and drop the terminal record.
    expect(result.firstThrew).toBe(true);
    // A deferral is not an outcome: the incident stays live for the re-run.
    expect(result.incidentStatusAfterFirst).not.toBe("exhausted");
    expect(result.incidentStatusAfterFirst).not.toBe("failed");
    // Second give-up (the deferred re-run on a healthy isolate): terminalizes
    // fully — banner delivered, incident sealed, no re-throw.
    expect(result.secondThrew).toBe(false);
    expect(result.incidentStatusAfterSecond).toBe("exhausted");
    expect(result.terminalBroadcast).toBe(terminalMessage);
    // `onExhausted` fired on both passes — the documented at-least-once edge
    // ("deliver a second banner" ≫ "silently drop the turn").
    expect(result.exhaustedReasons).toEqual([
      "stable_timeout",
      "stable_timeout"
    ]);
  });

  it("still terminalizes if the ai-chat incident read fails during give-up bookkeeping", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    const terminalMessage = "The assistant was interrupted. Please try again.";

    const result = await agentStub.testStableTimeoutIncidentReadBestEffort({
      transientMessage: "Network connection lost.",
      terminalMessage
    });

    // The incident read only backs the duplicate-alarm guard. If storage
    // rejects here, ai-chat should synthesize an incident and still deliver the
    // terminal UX (matching Think's `_exhaustRecoveryGiveUp`).
    expect(result.threw).toBe(false);
    expect(result.terminalBroadcast).toBe(terminalMessage);
    expect(result.exhaustedReasons).toEqual(["stable_timeout"]);
    expect(result.incidentStatus).toBe("exhausted");
  });

  it("does not defer/replay ai-chat give-up when the post-terminal incident seal write fails", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    const terminalMessage = "The assistant was interrupted. Please try again.";

    const result = await agentStub.testStableTimeoutSealWriteBestEffort({
      transientMessage: "Network connection lost.",
      terminalMessage
    });

    // `_exhaustChatRecovery` already delivered the banner and persisted the
    // durable terminal record. The incident seal is best-effort bookkeeping, so
    // a transient here must not propagate to `_executeScheduleCallback` and
    // re-deliver the whole give-up unnecessarily.
    expect(result.threw).toBe(false);
    expect(result.terminalBroadcast).toBe(terminalMessage);
    expect(result.exhaustedReasons).toEqual(["stable_timeout"]);
    expect(result.incidentStatus).not.toBe("exhausted");
  });

  it("shares one attempt budget when an incident flips between retry and continue", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    const first = await agentStub.beginIncidentForTest({
      requestId: "req-flip",
      recoveryRootRequestId: "req-flip",
      latestUserMessageId: "user-flip",
      recoveryKind: "retry",
      nowMs: 1_000_000
    });
    const second = await agentStub.beginIncidentForTest({
      requestId: "req-flip-2",
      recoveryRootRequestId: "req-flip",
      latestUserMessageId: "user-flip",
      recoveryKind: "continue",
      // >30s after the first so alarm-debounce doesn't collapse the attempt.
      nowMs: 1_040_000
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

  it("#1691: a new turn's orphan is its own message, NOT merged into the previous assistant", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.setRecoveryOverride({ continue: false });

    // History: user-one, assistant-one (already answered), user-two (new turn).
    await agentStub.persistMessages([
      {
        id: "user-one",
        role: "user",
        parts: [{ type: "text", text: "first question" }]
      },
      {
        id: "assistant-one",
        role: "assistant",
        parts: [{ type: "text", text: "first response" }]
      },
      {
        id: "user-two",
        role: "user",
        parts: [{ type: "text", text: "second question" }]
      }
    ] as ChatMessage[]);

    // New (non-continuation) response stream for user-two whose chunks carry
    // NO provider start.messageId. The allocated assistant id is stored in
    // stream metadata so recovery can re-create it as its own message.
    await agentStub.insertInterruptedStream(
      "stream-1691",
      "req-1691",
      makeChunks(["second response"]),
      undefined,
      { messageId: "assistant-two" }
    );
    await agentStub.triggerInterruptedStreamCheck();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const textOf = (m: ChatMessage) =>
      m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");

    // assistant-one must remain untouched.
    expect(textOf(messages.find((m) => m.id === "assistant-one")!)).toBe(
      "first response"
    );
    // The recovered turn is its own NEW assistant message.
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(2);
    expect(textOf(messages.find((m) => m.id === "assistant-two")!)).toBe(
      "second response"
    );
  });

  it("#1691: a continuation orphan WITHOUT a provider messageId still merges into the last assistant", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.setRecoveryOverride({ continue: false });

    await agentStub.persistMessages([
      {
        id: "user-one",
        role: "user",
        parts: [{ type: "text", text: "question" }]
      },
      {
        id: "assistant-one",
        role: "assistant",
        parts: [{ type: "text", text: "partial " }]
      }
    ] as ChatMessage[]);

    // Continuation stream: metadata records the cloned last-assistant id, so
    // recovery reuses it and appends onto assistant-one. No continuation
    // flag and no base part count: a row imported from 0.8.4 looks like this.
    await agentStub.insertInterruptedStream(
      "stream-cont",
      "req-cont",
      makeChunks(["continued"]),
      undefined,
      { messageId: "assistant-one" }
    );
    await agentStub.triggerInterruptedStreamCheck();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(
      assistantMessages[0].parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("")
    ).toBe("partial continued");
  });

  it("#1691: legacy rows without metadata keep the pre-fix continuation fallback", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.setRecoveryOverride({ continue: false });

    await agentStub.persistMessages([
      {
        id: "user-one",
        role: "user",
        parts: [{ type: "text", text: "question" }]
      },
      {
        id: "assistant-one",
        role: "assistant",
        parts: [{ type: "text", text: "partial " }]
      }
    ] as ChatMessage[]);

    // No metadata (messageId omitted) → simulates a row written before #1691.
    // Backward-compatible fallback appends to last assistant.
    await agentStub.insertInterruptedStream(
      "stream-legacy",
      "req-legacy",
      makeChunks(["continued"])
    );
    await agentStub.triggerInterruptedStreamCheck();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(
      assistantMessages[0].parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("")
    ).toBe("partial continued");
  });

  it("#1691: a provider start.messageId is preserved over the stored id (matches the live path)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.setRecoveryOverride({ continue: false });

    await agentStub.persistMessages([
      {
        id: "user-one",
        role: "user",
        parts: [{ type: "text", text: "question" }]
      }
    ] as ChatMessage[]);

    // The chunks carry a provider `start.messageId` ("provider-msg"). For a new
    // turn the live path ADOPTS that id (see `_streamSSEReply`), so the message
    // is persisted under it. Recovery must do the same, even though metadata
    // also recorded the id allocated before the provider id was seen — otherwise
    // a recovered turn would diverge from a completed live turn. The stored id
    // is only a fallback for when no provider id is present.
    await agentStub.insertInterruptedStream(
      "stream-prefer",
      "req-prefer",
      makeChunks(["answer"], "provider-msg"),
      undefined,
      { messageId: "allocated-msg" }
    );
    await agentStub.triggerInterruptedStreamCheck();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].id).toBe("provider-msg");
  });

  it("#1691: recovering after an early (tool-approval) persist does not duplicate the tool part", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.setRecoveryOverride({ continue: false });

    // Simulate the state after an early persist at tool approval: the assistant
    // message already exists with the tool part, and the stream's stored chunks
    // (which recovery replays in full) reconstruct that SAME tool part. The
    // merge must not leave two parts with the same toolCallId.
    await agentStub.persistMessages([
      {
        id: "user-one",
        role: "user",
        parts: [{ type: "text", text: "q" }]
      },
      {
        id: "assistant-early",
        role: "assistant",
        parts: [
          {
            type: "tool-myTool",
            toolCallId: "tc-dup",
            toolName: "myTool",
            state: "input-available",
            input: { x: 1 }
          }
        ] as unknown as ChatMessage["parts"]
      }
    ] as ChatMessage[]);

    await agentStub.insertInterruptedStream(
      "stream-dup",
      "req-dup",
      [
        { body: JSON.stringify({ type: "start" }), index: 0 },
        {
          body: JSON.stringify({
            type: "tool-input-start",
            toolCallId: "tc-dup",
            toolName: "myTool"
          }),
          index: 1
        },
        {
          body: JSON.stringify({
            type: "tool-input-available",
            toolCallId: "tc-dup",
            toolName: "myTool",
            input: { x: 1 }
          }),
          index: 2
        },
        { body: JSON.stringify({ type: "text-start", id: "t" }), index: 3 },
        {
          body: JSON.stringify({
            type: "text-delta",
            id: "t",
            delta: "answer"
          }),
          index: 4
        }
      ],
      undefined,
      { messageId: "assistant-early" }
    );
    await agentStub.triggerInterruptedStreamCheck();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistant = messages.find((m) => m.id === "assistant-early");
    expect(assistant).toBeDefined();
    const toolParts = assistant!.parts.filter(
      (p) =>
        "toolCallId" in p &&
        (p as { toolCallId?: string }).toolCallId === "tc-dup"
    );
    expect(toolParts).toHaveLength(1);
  });

  it("#1691: two sequentially recovered new turns stay distinct (not merged into each other)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);

    await agentStub.setRecoveryOverride({ continue: false });

    // ai-chat serializes to one active stream, so orphans are recovered one at
    // a time. Two interrupted NEW turns recovered in sequence must each become
    // their own assistant message, never merging into one another.
    await agentStub.persistMessages([
      { id: "user-1", role: "user", parts: [{ type: "text", text: "q1" }] },
      { id: "user-2", role: "user", parts: [{ type: "text", text: "q2" }] }
    ] as ChatMessage[]);

    await agentStub.insertInterruptedStream(
      "seq-1",
      "req-seq-1",
      makeChunks(["answer one"]),
      undefined,
      { messageId: "asst-seq-1" }
    );
    await agentStub.triggerInterruptedStreamCheck();

    await agentStub.insertInterruptedStream(
      "seq-2",
      "req-seq-2",
      makeChunks(["answer two"]),
      undefined,
      { messageId: "asst-seq-2" }
    );
    await agentStub.triggerInterruptedStreamCheck();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages.map((m) => m.id).sort()).toEqual([
      "asst-seq-1",
      "asst-seq-2"
    ]);
    const textOf = (id: string) =>
      messages
        .find((m) => m.id === id)!
        .parts.filter(
          (p): p is { type: "text"; text: string } => p.type === "text"
        )
        .map((p) => p.text)
        .join("");
    expect(textOf("asst-seq-1")).toBe("answer one");
    expect(textOf("asst-seq-2")).toBe("answer two");
  });

  // ── Continue-path (fiber recovery) tests ────────────────────────────────
  // The default chatRecovery flow does NOT go through the reconnect-ACK
  // `_persistOrphanedStream` path the tests above drive — it schedules a fiber
  // continuation (`_chatRecoveryContinue` -> `continueLastTurn`). These tests
  // exercise that real path via `triggerFiberRecovery` + the scheduled continue.
  const chatTurnSnapshot = (requestId: string, userId: string) => ({
    __cfAIChatFiberSnapshot: {
      kind: "ai-chat-turn",
      version: 1,
      requestId,
      continuation: false,
      latestMessageId: userId,
      latestMessageRole: "user",
      latestUserMessageId: userId,
      startedAt: Date.now()
    },
    user: null
  });
  const assistantText = (messages: ChatMessage[], id: string) =>
    (messages.find((m) => m.id === id)?.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");

  it("#1691 (continue path): a recovered NEW turn continues as its own message, not the previous one", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setRecoveryOverride({});

    await agentStub.persistMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "q1" }] },
      {
        id: "assistant-one",
        role: "assistant",
        parts: [{ type: "text", text: "first answer" }]
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "q2" }] }
    ] as ChatMessage[]);

    // Interrupted NEW turn for u2: partial chunks carry NO provider
    // start.messageId, but the allocated id is recorded in stream metadata.
    await agentStub.insertInterruptedStream(
      "stream-fc1",
      "req-fc1",
      makeChunks(["partial two "]),
      undefined,
      { messageId: "assistant-two" }
    );
    await agentStub.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-fc1",
      chatTurnSnapshot("req-fc1", "u2")
    );

    await agentStub.triggerFiberRecovery();
    await agentStub.runScheduledRecoveryContinueForTest();
    await agentStub.waitForIdleForTest();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(assistantText(messages, "assistant-one")).toBe("first answer");
    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistantText(messages, "assistant-two")).toContain("partial two");
    expect(assistantText(messages, "assistant-two")).toContain(
      "Continued response."
    );
  });

  it("#1691 (continue path): an empty partial (no parts persisted) does not merge the new turn into the previous one", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setRecoveryOverride({});

    await agentStub.persistMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "q1" }] },
      {
        id: "assistant-one",
        role: "assistant",
        parts: [{ type: "text", text: "first answer" }]
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "q2" }] }
    ] as ChatMessage[]);

    // Interrupted in the window AFTER `start` but BEFORE any text/tool part, so
    // the orphan reconstructs to zero parts and nothing is persisted for u2.
    await agentStub.insertInterruptedStream(
      "stream-fc2",
      "req-fc2",
      [{ body: JSON.stringify({ type: "start" }), index: 0 }],
      undefined,
      { messageId: "assistant-two" }
    );
    await agentStub.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-fc2",
      chatTurnSnapshot("req-fc2", "u2")
    );

    await agentStub.triggerFiberRecovery();
    await agentStub.runScheduledRecoveryContinueForTest();
    await agentStub.runScheduledRecoveryRetryForTest();
    await agentStub.waitForIdleForTest();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    // The previous turn must be untouched.
    expect(assistantText(messages, "assistant-one")).toBe("first answer");
    // u2 must get its own assistant message, not be folded into assistant-one.
    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
  });

  it("#1691 (continue path): persist:false on a new turn does not merge it into the previous one", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setRecoveryOverride({ persist: false });

    await agentStub.persistMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "q1" }] },
      {
        id: "assistant-one",
        role: "assistant",
        parts: [{ type: "text", text: "first answer" }]
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "q2" }] }
    ] as ChatMessage[]);

    // A real partial exists, but the app opts out of persisting it.
    await agentStub.insertInterruptedStream(
      "stream-fc3",
      "req-fc3",
      makeChunks(["discarded partial "]),
      undefined,
      { messageId: "assistant-two" }
    );
    await agentStub.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-fc3",
      chatTurnSnapshot("req-fc3", "u2")
    );

    await agentStub.triggerFiberRecovery();
    await agentStub.runScheduledRecoveryContinueForTest();
    await agentStub.runScheduledRecoveryRetryForTest();
    await agentStub.waitForIdleForTest();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(assistantText(messages, "assistant-one")).toBe("first answer");
    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
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

  it("recovers a lane turn whose model call began, with its stash data", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setRecoveryOverride({ continue: false });
    await agentStub.persistMessages([
      { id: "user-1", role: "user", parts: [{ type: "text", text: "Hello" }] }
    ] as ChatMessage[]);
    await agentStub.insertInterruptedStream(
      "stream-lane",
      "req-lane",
      makeChunks(["Lane recovery text"], "assistant-lane")
    );
    await agentStub.insertInterruptedLaneTurn("req-lane", true, {
      someUserData: true
    });

    await agentStub.triggerFiberRecovery();

    const contexts = (await agentStub.getRecoveryContexts()) as Array<{
      streamId: string;
      partialText: string;
      recoveryData: unknown;
    }>;
    const context = contexts[contexts.length - 1];
    expect(context?.streamId).toBe("stream-lane");
    expect(context?.partialText).toBe("Lane recovery text");
    expect(context?.recoveryData).toEqual({ someUserData: true });
  });

  it("does not recover a lane turn whose model call never began", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getTestAgent(room);
    await agentStub.setRecoveryOverride({ continue: false });
    await agentStub.insertInterruptedLaneTurn("req-queued", false);

    await agentStub.triggerFiberRecovery();

    expect(await agentStub.getRecoveryContexts()).toEqual([]);
    expect(await agentStub.getActiveFibers()).toEqual([]);
    // Its run ended, so the lane is free.
    expect(await agentStub.openChatTurnRunsForTest()).toBe(0);
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

  it("should not double-recover when fiber recovery runs from both onStart and alarm", async () => {
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

  it("runs an attempt too large for a step's journal in a run of its own", async () => {
    const agentStub = await getTestAgent(
      `large-attempt-${crypto.randomUUID()}`
    );
    await agentStub.persistMessages([
      { id: "u-big", role: "user", parts: [{ type: "text", text: "Hi" }] },
      {
        id: "a-big",
        role: "assistant",
        parts: [{ type: "text", text: "Partial" }]
      }
    ]);
    await agentStub.seedIncidentForTest({
      incidentId: "inc-big",
      requestId: "root-big",
      recoveryRootRequestId: "root-big",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      scheduleCount: 1,
      scheduled: {
        callback: "_chatRecoveryContinue",
        targetMessageId: "a-big"
      },
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });
    // The interrupted request's body rides in the attempt: 1.5 MiB here,
    // past what a turn's run can journal (1 MiB), so it gets its own run.
    await agentStub.startAttemptRunForTest(
      "_chatRecoveryContinue",
      {
        incidentId: "inc-big",
        originalRequestId: "root-big",
        targetAssistantId: "a-big",
        delivery: 1,
        lastBody: { big: "x".repeat(1_500_000) }
      },
      0
    );

    // The run starts from the alarm and continues the reply, once.
    await vi.waitFor(
      async () => {
        expect(await agentStub.getIncidentForTest("inc-big")).toBeNull();
      },
      { timeout: 10_000, interval: 20 }
    );
    await agentStub.waitForIdleForTest();
    expect(await agentStub.getOnChatMessageCallCount()).toBe(1);
    expect(
      await agentStub.getScheduleCountForCallback("_chatRecoveryContinue")
    ).toBe(0);
    const stored = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(
      stored[1].parts.map((p) => (p as { text?: string }).text ?? "").join("")
    ).toContain("Continued response.");
  }, 20_000);

  it("finishes a recovery run an earlier version enqueued, after its backoff", async () => {
    const agentStub = await getTestAgent(`upgrade-${crypto.randomUUID()}`);
    await agentStub.persistMessages([
      { id: "u-up", role: "user", parts: [{ type: "text", text: "Hi" }] },
      {
        id: "a-up",
        role: "assistant",
        parts: [{ type: "text", text: "Partial" }]
      }
    ]);
    // What the earlier version left: a scheduled incident, and its attempt
    // as a run of the recovery Task waiting out a backoff.
    await agentStub.seedIncidentForTest({
      incidentId: "inc-up",
      requestId: "root-up",
      recoveryRootRequestId: "root-up",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      scheduleCount: 1,
      scheduled: { callback: "_chatRecoveryContinue", targetMessageId: "a-up" },
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });
    await agentStub.seedReleasedRecoveryRunForTest(
      "_chatRecoveryContinue",
      {
        incidentId: "inc-up",
        originalRequestId: "root-up",
        targetAssistantId: "a-up",
        delivery: 1
      },
      60
    );
    expect(await agentStub.openReleasedRecoveryRunsForTest()).toBe(1);

    // This version runs it: the reply is continued, once, and the run ends.
    await agentStub.runScheduledRecoveryContinueForTest();
    await agentStub.waitForIdleForTest();
    expect(await agentStub.getOnChatMessageCallCount()).toBe(1);
    expect(await agentStub.getIncidentForTest("inc-up")).toBeNull();
    expect(await agentStub.openReleasedRecoveryRunsForTest()).toBe(0);
    const stored = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(
      stored[1].parts.map((p) => (p as { text?: string }).text ?? "").join("")
    ).toContain("Continued response.");
  });

  it("retries, in its own run, a recovery run an earlier version enqueued that times out waiting for a stable chat", async () => {
    const agentStub = await getTestAgent(`upgrade-wait-${crypto.randomUUID()}`);
    await agentStub.persistMessages([
      { id: "u-x", role: "user", parts: [{ type: "text", text: "Hi" }] },
      {
        id: "a-x",
        role: "assistant",
        parts: [{ type: "text", text: "Partial" }]
      }
    ]);
    await agentStub.setForceStableTimeoutForTest(true);
    await agentStub.seedIncidentForTest({
      incidentId: "inc-wait",
      requestId: "root-wait",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });
    await agentStub.seedReleasedRecoveryRunForTest(
      "_chatRecoveryContinue",
      {
        incidentId: "inc-wait",
        originalRequestId: "root-wait",
        targetAssistantId: "a-x"
      },
      60
    );
    await agentStub.runScheduledRecoveryContinueForTest();

    // The attempt timed out waiting and planned the next one into its own
    // run: still one run, now waiting out the retry's delay.
    expect(
      await agentStub.getScheduleCountForCallback("_chatRecoveryContinue")
    ).toBe(1);
    expect(await agentStub.openReleasedRecoveryRunsForTest()).toBe(1);
    const steps = await agentStub.recoveryRunStepsForTest();
    expect(steps).toEqual(
      expect.arrayContaining(["backoff-2:waiting", "continuation:completed"])
    );
    expect(steps.some((step) => step.startsWith("continuation-2"))).toBe(false);
    const incident = await agentStub.getIncidentForTest("inc-wait");
    expect(incident?.attempt).toBe(2);
    expect(incident?.status).toBe("scheduled");
    expect(await agentStub.getOnChatMessageCallCount()).toBe(0);

    // The retry fires in that run once the chat is stable: the reply is
    // continued and the run ends.
    await agentStub.setForceStableTimeoutForTest(false);
    await agentStub.runScheduledRecoveryContinueForTest();
    await agentStub.waitForIdleForTest();
    expect(await agentStub.getOnChatMessageCallCount()).toBe(1);
    expect(await agentStub.getIncidentForTest("inc-wait")).toBeNull();
    expect(
      await agentStub.getScheduleCountForCallback("_chatRecoveryContinue")
    ).toBe(0);
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

  it("retries a question past an earlier reply an older version stored with a dead tool call", async () => {
    const agentStub = await getTestAgent(`retry-legacy-${crypto.randomUUID()}`);

    // An older version stored a cut-off reply as it was: its server tool
    // call still looks like it is running. The user then asked again, and
    // that turn was interrupted before it streamed.
    await agentStub.persistPendingToolCallForTest(
      "assistant-legacy",
      "previewTool"
    );
    await agentStub.persistMessages([
      ...((await agentStub.getPersistedMessages()) as ChatMessage[]),
      {
        id: "user-retry",
        role: "user",
        parts: [{ type: "text", text: "Try again" }]
      }
    ]);

    // The retry does not wait on the dead call: it settles it and answers.
    await agentStub.runRecoveryRetryForTest({ targetUserId: "user-retry" });
    await agentStub.waitForIdleForTest();

    expect(await agentStub.getOnChatMessageCallCount()).toBe(1);
    const stored = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(stored[0].parts[0]).toMatchObject({ state: "output-error" });
    expect(stored.at(-1)?.role).toBe("assistant");
  }, 8_000);

  it("asks a subclass's hasPendingClientInteraction whether a client is still to answer", async () => {
    const agentStub = await getTestAgent(
      `stable-park-override-${crypto.randomUUID()}`
    );
    await agentStub.setForceStableTimeoutForTest(true);
    // Nothing in the transcript is unanswered. The subclass says a client
    // still has to answer something only it knows about.
    await agentStub.setPendingClientInteractionForTest(true);
    await agentStub.persistMessages([
      {
        id: "user-override",
        role: "user",
        parts: [{ type: "text", text: "hello" }]
      },
      {
        id: "assistant-override",
        role: "assistant",
        parts: [{ type: "text", text: "partial" }]
      }
    ]);
    await agentStub.seedIncidentForTest({
      incidentId: "inc-override",
      requestId: "root-override",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });
    const continueData = {
      incidentId: "inc-override",
      originalRequestId: "root-override",
      targetAssistantId: "assistant-override"
    };
    await agentStub.preScheduleRecoveryContinueForTest(continueData);
    await agentStub.runChatRecoveryContinueDirectForTest(continueData);

    const parked = await agentStub.getIncidentForTest("inc-override");
    expect(parked?.status).toBe("skipped");
    expect(parked?.reason).toBe("awaiting_client_interaction");
  });

  it.each<{
    name: string;
    recoveryKind: "retry" | "continue";
    scheduled?: {
      callback: "_chatRecoveryContinue" | "_chatRecoveryRetry";
      targetMessageId?: string;
    };
  }>([
    { name: "a scheduled retry", recoveryKind: "retry" },
    {
      name: "a retry scheduled on a continue incident",
      recoveryKind: "continue",
      scheduled: { callback: "_chatRecoveryRetry" }
    },
    {
      name: "a continue of another reply",
      recoveryKind: "continue",
      scheduled: {
        callback: "_chatRecoveryContinue",
        targetMessageId: "assistant-older"
      }
    }
  ])(
    "a client's answer does not take over $name",
    async ({ recoveryKind, scheduled }) => {
      const room = `answer-other-recovery-${crypto.randomUUID()}`;
      const agentStub = await getTestAgent(room);
      await agentStub.setRequestContextForTest(undefined, [
        { name: "chooseOption" }
      ]);
      await agentStub.persistPendingToolCallForTest(
        "assistant-latest",
        "chooseOption"
      );
      // A recovery is scheduled, but not to continue the latest reply.
      await agentStub.seedIncidentForTest({
        incidentId: "inc-other",
        requestId: "root-other",
        recoveryKind,
        attempt: 1,
        maxAttempts: 6,
        status: "scheduled",
        firstSeenAt: Date.now(),
        lastAttemptAt: Date.now(),
        ...(scheduled && { scheduled })
      });

      // The client answers the latest reply's tool call, and the answer's
      // turn continues that reply.
      const { ws } = await connectChatWS(
        `/agents/chat-recovery-test-agent/${room}`
      );
      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_TOOL_RESULT,
          toolCallId: "call_assistant-latest",
          toolName: "chooseOption",
          output: { choice: "a" },
          autoContinue: true
        })
      );
      await expect
        .poll(() => agentStub.getOnChatMessageCallCount(), { timeout: 5000 })
        .toBe(1);
      await agentStub.waitForIdleForTest();
      ws.close(1000);

      // The other recovery is still scheduled. It reaches its own leaf check.
      const incident = await agentStub.getIncidentForTest("inc-other");
      expect(incident?.status).toBe("scheduled");
    },
    15_000
  );

  it("RECOVERS a dead SERVER-tool orphan on continue (repairs to errored, then continues) instead of waiting-then-exhausting", async () => {
    const agentStub = await getTestAgent(
      `stable-recover-${crypto.randomUUID()}`
    );
    // Real stability wait (NOT forced): the narrow recovery predicate must let a
    // dead server-tool orphan through as "stable" so it is repaired + continued,
    // converging ai-chat with `@cloudflare/think` (which already recovers here).
    await agentStub.setForceStableTimeoutForTest(false);

    // `previewTool` is NOT a registered client tool, so its `input-available`
    // part is a dead SERVER orphan (its `execute()` died with the isolate). The
    // contrast with the CLIENT-interaction park test above is the whole point:
    // a client orphan parks, a dead server orphan recovers.
    await agentStub.setRequestContextForTest(undefined, [
      { name: "chooseOption" }
    ]);
    await agentStub.persistPendingToolCallForTest(
      "assistant-recover",
      "previewTool"
    );

    await agentStub.seedIncidentForTest({
      incidentId: "inc-recover",
      requestId: "root-recover",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    await agentStub.runChatRecoveryContinueDirectForTest({
      incidentId: "inc-recover",
      originalRequestId: "root-recover",
      targetAssistantId: "assistant-recover"
    });
    await agentStub.waitForIdleForTest();

    // The orphaned server-tool part was repaired to an errored result (no longer
    // `input-available`), so the next provider call won't 400 with
    // `AI_MissingToolResultsError`.
    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const orphan = messages.find((m) => m.id === "assistant-recover");
    const toolPart = orphan?.parts.find(
      (p) =>
        "toolCallId" in p &&
        (p as { toolCallId?: string }).toolCallId === "call_assistant-recover"
    ) as { state?: string } | undefined;
    expect(toolPart?.state).toBe("output-error");

    // It CONTINUED (ran inference) rather than parking/exhausting on a dead
    // orphan, and the incident terminalized as completed (deleted), NOT a
    // stable-timeout give-up.
    expect(await agentStub.getOnChatMessageCallCount()).toBe(1);
    const incident = await agentStub.getIncidentForTest("inc-recover");
    expect(incident).toBeNull();
  });

  it("PARKS a retry (no reschedule, no budget spent) while a CLIENT interaction is pending", async () => {
    const agentStub = await getTestAgent(
      `stable-retry-park-${crypto.randomUUID()}`
    );
    await agentStub.setForceStableTimeoutForTest(true);

    // Same HITL park condition as the continue-path test, exercised through the
    // RETRY loop: a CLIENT-tool `input-available` orphan the SPA will replay
    // after reconnect, so `waitUntilStable` timing out is the human being slow,
    // not churn. Guards the retry path's call to the shared park helper.
    await agentStub.setRequestContextForTest(undefined, [
      { name: "chooseOption" }
    ]);
    await agentStub.persistPendingToolCallForTest(
      "assistant-retry-park",
      "chooseOption"
    );

    await agentStub.seedIncidentForTest({
      incidentId: "inc-retry-park",
      requestId: "root-retry-park",
      recoveryKind: "retry",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    const retryData = {
      incidentId: "inc-retry-park",
      originalRequestId: "root-retry-park",
      targetUserId: "u-x"
    };
    await agentStub.preScheduleRecoveryRetryForTest(retryData);
    await agentStub.runChatRecoveryRetryDirectForTest(retryData);

    // No NEW reschedule row (only the pre-scheduled executing row remains) and
    // the attempt count did NOT advance — the stable-timeout budget was not
    // spent. The incident is parked `skipped` for the client's eventual replay.
    expect(
      await agentStub.getScheduleCountForCallback("_chatRecoveryRetry")
    ).toBe(1);
    const parked = await agentStub.getIncidentForTest("inc-retry-park");
    expect(parked?.attempt).toBe(1);
    expect(parked?.status).toBe("skipped");
    expect(parked?.reason).toBe("awaiting_client_interaction");
  });

  it("exhausts via onExhausted once the stable-state continue budget is spent", async () => {
    const agentStub = await getTestAgent(
      `stable-exhaust-${crypto.randomUUID()}`
    );
    await agentStub.enableExhaustedCaptureForTest(6, "the assistant gave up");
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

    // No re-arm: the budget is spent.
    expect(
      await agentStub.getScheduleCountForCallback("_chatRecoveryContinue")
    ).toBe(0);
    // The incident is sealed `exhausted` (not the old silent `failed`).
    const incident = await agentStub.getIncidentForTest("inc-exhaust");
    expect(incident?.status).toBe("exhausted");
    expect(incident?.reason).toBe("stable_timeout");
    // onExhausted fires exactly once with the terminalMessage — the regression
    // this guards (apps relying on it for the terminal banner).
    const exhausted = await agentStub.getExhaustedContextsForTest();
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].reason).toBe("stable_timeout");
    expect(exhausted[0].recoveryKind).toBe("continue");
    expect(exhausted[0].terminalMessage).toBe("the assistant gave up");
  });

  it("exhausts via onExhausted once the stable-state retry budget is spent", async () => {
    const agentStub = await getTestAgent(
      `stable-exhaust-retry-${crypto.randomUUID()}`
    );
    await agentStub.enableExhaustedCaptureForTest(6, "retry gave up");
    await agentStub.setForceStableTimeoutForTest(true);
    await agentStub.seedIncidentForTest({
      incidentId: "inc-exhaust-retry",
      requestId: "root-exhaust-retry",
      recoveryKind: "retry",
      attempt: 6,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    await agentStub.runChatRecoveryRetryDirectForTest({
      incidentId: "inc-exhaust-retry",
      originalRequestId: "root-exhaust-retry",
      targetUserId: "u-x"
    });

    expect(
      await agentStub.getScheduleCountForCallback("_chatRecoveryRetry")
    ).toBe(0);
    const incident = await agentStub.getIncidentForTest("inc-exhaust-retry");
    expect(incident?.status).toBe("exhausted");
    expect(incident?.reason).toBe("stable_timeout");
    const exhausted = await agentStub.getExhaustedContextsForTest();
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].reason).toBe("stable_timeout");
    expect(exhausted[0].recoveryKind).toBe("retry");
    expect(exhausted[0].terminalMessage).toBe("retry gave up");
  });

  it("gives up with the terminal message when a recovery attempt throws", async () => {
    const agentStub = await getTestAgent(
      `recovery-throws-${crypto.randomUUID()}`
    );
    await agentStub.enableExhaustedCaptureForTest(6, "the assistant gave up");
    await agentStub.setStableWaitErrorForTest("application bug");
    await agentStub.seedIncidentForTest({
      incidentId: "inc-throws",
      requestId: "root-throws",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    // The attempt does not throw into the Task, which would retry it and
    // then drop it with the incident still "scheduled".
    await agentStub.runChatRecoveryContinueDirectForTest({
      incidentId: "inc-throws",
      originalRequestId: "root-throws",
      targetAssistantId: "a-x"
    });

    const incident = await agentStub.getIncidentForTest("inc-throws");
    expect(incident?.status).toBe("exhausted");
    expect(incident?.reason).toBe("recovery_error");
    const exhausted = await agentStub.getExhaustedContextsForTest();
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].reason).toBe("recovery_error");
    expect(exhausted[0].terminalMessage).toBe("the assistant gave up");
  });

  it("terminalizes a stable-state give-up even when the incident record is missing (silent-drop guard)", async () => {
    const agentStub = await getTestAgent(
      `stable-silent-drop-${crypto.randomUUID()}`
    );
    await agentStub.enableExhaustedCaptureForTest(6, "lost incident gave up");
    await agentStub.setForceStableTimeoutForTest(true);
    // No incident is seeded: simulate a stale alarm firing after the incident
    // record was swept/deleted. The give-up must STILL terminalize through
    // onExhausted rather than drop the turn into an eternal spinner.

    await agentStub.runChatRecoveryContinueDirectForTest({
      incidentId: "inc-gone",
      originalRequestId: "root-missing",
      targetAssistantId: "a-x"
    });

    const exhausted = await agentStub.getExhaustedContextsForTest();
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].reason).toBe("stable_timeout");
    expect(exhausted[0].recoveryRootRequestId).toBe("root-missing");
    expect(exhausted[0].terminalMessage).toBe("lost incident gave up");
  });

  it("does not re-fire onExhausted when a duplicate stale alarm runs after exhaustion", async () => {
    const agentStub = await getTestAgent(
      `stable-exhaust-dup-${crypto.randomUUID()}`
    );
    await agentStub.enableExhaustedCaptureForTest(6, "gave up once");
    await agentStub.setForceStableTimeoutForTest(true);
    await agentStub.seedIncidentForTest({
      incidentId: "inc-dup",
      requestId: "root-dup",
      recoveryKind: "continue",
      attempt: 6,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    const data = {
      incidentId: "inc-dup",
      originalRequestId: "root-dup",
      targetAssistantId: "a-x"
    };
    // First give-up terminalizes; the incident is sealed `exhausted`.
    await agentStub.runChatRecoveryContinueDirectForTest(data);
    // A duplicate stale alarm fires the SAME callback again (ai-chat has no
    // durable-submission short-circuit, so the incident-status guard is the
    // only thing preventing a second terminal banner / onExhausted).
    await agentStub.runChatRecoveryContinueDirectForTest(data);

    const exhausted = await agentStub.getExhaustedContextsForTest();
    expect(exhausted).toHaveLength(1);
    const incident = await agentStub.getIncidentForTest("inc-dup");
    expect(incident?.status).toBe("exhausted");
  });

  it("tracks a durable 'recovering…' record, cleared on terminal (#1620)", async () => {
    const agentStub = await getTestAgent(`recovering-${crypto.randomUUID()}`);
    const begun = await agentStub.beginIncidentForTest({
      requestId: "root-rec",
      recoveryRootRequestId: "root-rec",
      latestUserMessageId: "u1",
      recoveryKind: "continue"
    });

    // Scheduling marks the turn "recovering" (durable so set/clear stay
    // consistent across the isolates a recovery spans).
    await agentStub.updateIncidentForTest(begun.incidentId, "scheduled");
    expect((await agentStub.getChatRecoveringForTest())?.requestId).toBe(
      "root-rec"
    );

    // A terminal outcome clears it so the indicator can't spin forever.
    await agentStub.updateIncidentForTest(begun.incidentId, "failed", "boom");
    expect(await agentStub.getChatRecoveringForTest()).toBeNull();
  });

  it("replays the 'recovering…' status on connect, cleared on terminal (#1620 convergence)", async () => {
    const agentStub = await getTestAgent(
      `recovering-connect-${crypto.randomUUID()}`
    );
    const begun = await agentStub.beginIncidentForTest({
      requestId: "root-rec",
      recoveryRootRequestId: "root-rec",
      latestUserMessageId: "u1",
      recoveryKind: "continue"
    });

    // Before a continuation is scheduled there is no recovering status to replay.
    expect(await agentStub.getRecoveringConnectFrameForTest()).toBeNull();

    // Scheduling marks the turn "recovering"; a client connecting mid-recovery
    // (no active stream) now learns the turn is working, not frozen — matching
    // @cloudflare/think. (Previously AIChatAgent only broadcast it live.)
    await agentStub.updateIncidentForTest(begun.incidentId, "scheduled");
    const frame = await agentStub.getRecoveringConnectFrameForTest();
    expect(frame?.type).toBe("cf_agent_chat_recovering");
    expect(frame?.recovering).toBe(true);
    expect(frame?.id).toBe("root-rec");

    // A terminal outcome clears it so the on-connect replay can't spin forever.
    await agentStub.updateIncidentForTest(begun.incidentId, "failed", "boom");
    expect(await agentStub.getRecoveringConnectFrameForTest()).toBeNull();
  });

  // #1645: a recovery that exhausts while NO client is connected currently
  // only broadcasts the terminal frame transiently — there is no durable
  // record, so a client that (re)connects afterward and runs the standard
  // resume probe is told RESUME_NONE and the failed turn stays frozen.
  // This drives the real WebSocket reconnect protocol against a real DO.
  it("tells a tab that reconnects the app's terminal message for a turn whose recovery gave up (#1645)", async () => {
    const room = `terminal-reconnect-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);
    const TERMINAL = "Recovery exhausted — the assistant could not finish.";
    await agentStub.setChatRecoveryConfigForTest({
      maxAttempts: 1,
      terminalMessage: TERMINAL
    });

    // Every attempt streams a little and stalls: the budget is spent with no
    // client connected.
    expect(
      await agentStub.driveStallingTurnForTest({
        timeoutMs: 100,
        hangTurns: 20
      })
    ).toBe("error");
    const [requestId] = await agentStub.endedRequestIdsForTest();

    const asked = await endsOnReconnect(room, [requestId]);
    expect(
      asked.end,
      `expected the request's end on reconnect; received frame types: ${JSON.stringify(asked.types)}`
    ).toMatchObject({
      id: requestId,
      done: true,
      error: true,
      body: TERMINAL
    });
  }, 15_000);

  // #1645 (clear-on-success): the durable terminal record must be superseded
  // when a LATER turn succeeds — including a turn driven purely server-side via
  // `saveMessages` (no client request in between, which is the only path that
  // would otherwise clear it). Otherwise the stale exhaustion replays to the
  // next client to connect, even though the conversation has since recovered.
  it("still tells a tab how its request ended after a later turn succeeded (#1645)", async () => {
    const room = `terminal-kept-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);
    const STREAM_ERROR = "Provider returned HTTP 500.";
    expect(await agentStub.driveErroredTurnForTest(STREAM_ERROR)).toBe("error");
    const [requestId] = await agentStub.endedRequestIdsForTest();

    // A later turn of the server's own completes.
    expect(await agentStub.driveSuccessfulTurnForTest()).toBe("completed");

    // Each request's end is kept under its own id: the later success does
    // not drop it.
    const asked = await endsOnReconnect(room, [requestId]);
    expect(asked.end).toMatchObject({
      id: requestId,
      done: true,
      error: true,
      body: STREAM_ERROR
    });
  });

  // #1645 (clear-on-abort): an ABORTED server-side turn must also supersede the
  // terminal record, not just a completed one. The conversation has moved on
  // either way; only a fresh error should leave a terminal to replay. The
  // client-submit path clears eagerly, so this gap is reachable only for turns
  // driven purely server-side (`saveMessages` / `continueLastTurn` with an
  // external abort signal).
  // A turn stopped before it starts stores nothing and calls nothing. The
  // conversation did not move, so the record of the failure before it stays
  // for a client that reconnects.
  it("still tells a tab how its request ended after a later turn was stopped before it started (#1645)", async () => {
    const room = `terminal-untouched-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);
    const STREAM_ERROR = "Provider returned HTTP 500.";
    expect(await agentStub.driveErroredTurnForTest(STREAM_ERROR)).toBe("error");
    const [requestId] = await agentStub.endedRequestIdsForTest();

    const aborted = await agentStub.driveAbortedTurnForTest("before");
    expect(aborted).toEqual({
      status: "aborted",
      userTexts: ["hello"],
      chatCalls: 0
    });

    const asked = await endsOnReconnect(room, [requestId]);
    expect(asked.end).toMatchObject({
      id: requestId,
      done: true,
      error: true,
      body: STREAM_ERROR
    });
  });

  // #1645 (record-on-error): a terminal NON-exhaustion error (e.g. a provider
  // 500 surfaced as a stream `error` part) must also be durably recorded, not
  // just broadcast transiently — otherwise a client disconnected at that moment
  // never learns the turn failed and stays frozen on reconnect. Brings ai-chat
  // to parity with Think's `_fireResponseHook`, which records on `error`.
  it("tells a tab that reconnects how the request it waited on ended in error (#1645)", async () => {
    const room = `terminal-error-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);
    const STREAM_ERROR = "Provider returned HTTP 500.";

    // A turn ends in a stream error with no client connected.
    expect(await agentStub.driveErroredTurnForTest(STREAM_ERROR)).toBe("error");
    const [requestId] = await agentStub.endedRequestIdsForTest();

    // A tab that was waiting on that request reconnects and asks: it learns
    // the turn failed, rather than being told nothing streams.
    const asked = await endsOnReconnect(room, [requestId]);
    expect(
      asked.end,
      `expected the request's end on reconnect; received frame types: ${JSON.stringify(asked.types)}`
    ).toMatchObject({
      id: requestId,
      done: true,
      error: true,
      body: STREAM_ERROR
    });

    // A tab that names no request learns nothing of ended ones.
    const unnamed = await endsOnReconnect(room, []);
    expect(unnamed.end).toBeUndefined();
    expect(unnamed.types).toContain(MessageType.CF_AGENT_STREAM_RESUME_NONE);
  });

  // #1645 (clear-on-chat-clear): clearing the conversation must also drop the
  // terminal record. Otherwise a stale exhaustion replays onto the now-empty
  // chat the next time a client connects and runs the resume probe.
  it("drops the terminal record when the conversation is cleared (#1645)", async () => {
    const room = `terminal-chatclear-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);

    const TERMINAL = "Recovery exhausted — the assistant could not finish.";

    await agentStub.enableExhaustedCaptureForTest(6, TERMINAL);
    await agentStub.setForceStableTimeoutForTest(true);
    await agentStub.seedIncidentForTest({
      incidentId: "inc-chatclear",
      requestId: "root-chatclear",
      recoveryKind: "continue",
      attempt: 6,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });
    await agentStub.runChatRecoveryContinueDirectForTest({
      incidentId: "inc-chatclear",
      originalRequestId: "root-chatclear",
      targetAssistantId: "a-chatclear"
    });
    expect(await agentStub.getPendingChatTerminalForTest()).toMatchObject({
      body: TERMINAL
    });

    // Clear the conversation over the real WS protocol.
    const { ws } = await connectChatWS(
      `/agents/chat-recovery-test-agent/${room}`
    );
    const seen: unknown[] = [];
    ws.addEventListener("message", (e) => {
      seen.push(JSON.parse(e.data as string));
    });
    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    // The clear is handled before the barrier that follows it.
    await socketBarrier(ws, seen);
    ws.close(1000);

    expect(await agentStub.getPendingChatTerminalForTest()).toBeNull();
  });
});

// Slice 3b (#1626): the live-stream inactivity watchdog. With
// `chatStreamStallTimeoutMs > 0`, a model/transport stream that parks between
// chunks is aborted and routed into the SAME bounded-recovery machinery a
// deploy/eviction interruption uses, instead of leaving the turn hung forever.
describe("stall watchdog (chatStreamStallTimeoutMs)", () => {
  it("retries a stalled live stream inside the turn, which completes with the partial kept", async () => {
    const room = `stall-route-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);

    // The model streams a partial then hangs; the watchdog trips after the gap.
    const stalled: unknown[] = [];
    const unsubscribe = subscribe("chat", (event) => {
      // Only this test's agent: the channel carries every agent's events.
      if (event.name === room && event.type === "chat:stream:stalled") {
        stalled.push(event.payload);
      }
    });
    let status: string;
    try {
      status = await agentStub.driveStallingTurnForTest({
        timeoutMs: 150,
        hangTurns: 1
      });
    } finally {
      unsubscribe();
    }
    // The stall is observable, as in `Think`.
    expect(stalled).toEqual([expect.objectContaining({ timeoutMs: 150 })]);

    // The stalled attempt is retried inside the turn, which completes.
    expect(status).toBe("completed");

    // The partial generated before the stall was persisted (not lost), so the
    // continuation re-anchors onto it rather than re-running from scratch.
    const messages = (await agentStub.getPersistedMessages()) as Array<{
      role: string;
      parts: Array<{ type: string; text?: string }>;
    }>;
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant, `messages=${JSON.stringify(messages)}`).toBeTruthy();
    expect(
      assistant?.parts.some(
        (p) =>
          p.type === "text" && (p.text ?? "").includes("partial before stall")
      )
    ).toBe(true);
  });

  it("bounds a turn that streams a chunk and stalls on every attempt", async () => {
    const agentStub = await getTestAgent(
      `stall-progress-${crypto.randomUUID()}`
    );
    await agentStub.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    // Every attempt streams a partial (progress) and then hangs.
    expect(
      await agentStub.driveStallingTurnForTest({
        timeoutMs: 100,
        hangTurns: 20
      })
    ).toBe("error");

    // The first attempt and two recoveries of it, and no more afterwards.
    expect(await agentStub.getOnChatMessageCallCount()).toBe(3);
    await agentStub.waitForIdleForTest();
    expect(await agentStub.getOnChatMessageCallCount()).toBe(3);
  }, 15_000);

  it("passes a healthy (non-stalling) stream through unchanged when the watchdog is armed", async () => {
    const room = `stall-healthy-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);

    // Arm the watchdog with a timeout comfortably above the (effectively
    // instant) inter-chunk gap of a healthy SSE stream. The guarded read path
    // must pass a non-stalling stream through unchanged — the turn completes
    // normally, with no recovery incident and no continuation scheduled, and
    // the watchdog timer must be cleared on completion (no spurious late trip).
    await agentStub.setChatStreamStallTimeoutForTest(1000);
    expect(await agentStub.driveSuccessfulTurnForTest()).toBe("completed");

    expect(await agentStub.getChatRecoveryIncidentsForTest()).toHaveLength(0);
    expect(
      await agentStub.getScheduleCountForCallback("_chatRecoveryContinue")
    ).toBe(0);
  });

  it("does not arm the watchdog when the stall timeout is 0 (default, opt-in)", async () => {
    const room = `stall-off-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);

    // Timeout 0 => watchdog disabled. A normal (non-hanging) turn completes as
    // usual with no recovery incident and no continuation scheduled.
    await agentStub.setChatStreamStallTimeoutForTest(0);
    expect(await agentStub.driveSuccessfulTurnForTest()).toBe("completed");

    expect(await agentStub.getChatRecoveryIncidentsForTest()).toHaveLength(0);
    expect(
      await agentStub.getScheduleCountForCallback("_chatRecoveryContinue")
    ).toBe(0);
  });
});

/**
 * A tab connects and asks about the requests it still waits on, as the
 * client does after a reconnect. Returns the end frame it was given for one
 * of them, if any, and the types of every frame it got.
 */
async function endsOnReconnect(
  room: string,
  requestIds: string[]
): Promise<{ end?: Record<string, unknown>; types: unknown[] }> {
  const { ws } = await connectChatWS(
    `/agents/chat-recovery-test-agent/${room}`
  );
  const received: Array<Record<string, unknown>> = [];
  const answered = new Promise<void>((resolve) => {
    ws.addEventListener("message", (event: MessageEvent) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }
      received.push(frame);
      if (frame.type === MessageType.CF_AGENT_STREAM_RESUMING) {
        // An ended request is offered like a stream: accept it.
        ws.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
            id: frame.id
          })
        );
      }
      if (
        frame.type === MessageType.CF_AGENT_STREAM_RESUME_NONE ||
        (frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          frame.done === true)
      ) {
        resolve();
      }
    });
  });
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST,
      requestIds,
      probeId: crypto.randomUUID()
    })
  );
  await answered;
  await socketBarrier(ws, received);
  ws.close(1000);
  return {
    end: received.find(
      (frame) =>
        frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        frame.done === true
    ),
    types: received.map((frame) => frame.type)
  };
}

/** The text of every stored assistant message, joined. */
async function storedAssistantText(agentStub: {
  getPersistedMessages(): Promise<unknown>;
}): Promise<string> {
  return (
    (await agentStub.getPersistedMessages()) as Array<{
      role: string;
      parts: Array<{ type: string; text?: string }>;
    }>
  )
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts)
    .map((part) => part.text ?? "")
    .join("");
}

describe("provider errors the chat turn reads itself", () => {
  it.each([
    ["a rate limit", 429, "Rate limit reached for requests"],
    ["an overloaded provider", 529, "Overloaded"],
    ["a server error", 503, "Service unavailable"]
  ])(
    "retries %s mid-stream inside the turn, which completes",
    async (_what, status, msg) => {
      const agentStub = await getTestAgent(
        `provider-error-${status}-${crypto.randomUUID()}`
      );
      expect(
        await agentStub.driveFailingReaderTurnForTest(msg, 1, {
          statusCode: status
        })
      ).toBe("completed");
      // The failed attempt's text is kept and the retry's follows it.
      const reply = await storedAssistantText(agentStub);
      expect(reply).toContain("partial before failure");
      expect(reply).toContain("Continued response.");
    }
  );

  it("reads a streamText provider error when the app lets it fail the stream", async () => {
    const agentStub = await getTestAgent(
      `provider-error-streamtext-${crypto.randomUUID()}`
    );
    // Read as transient: the turn is retried and completes.
    expect(await agentStub.driveStreamTextProviderErrorForTest(429, true)).toBe(
      "completed"
    );
  });

  it("reads an in-stream overload the app's onError sends as JSON", async () => {
    const agentStub = await getTestAgent(
      `provider-error-overload-${crypto.randomUUID()}`
    );
    // Read as transient: the turn is retried and completes.
    expect(await agentStub.driveStreamTextProviderErrorForTest(0, true)).toBe(
      "completed"
    );
  });

  it("cannot read a provider error that toUIMessageStreamResponse() masked", async () => {
    // The default `onError` sends "An error occurred." with no status.
    const agentStub = await getTestAgent(
      `provider-error-masked-${crypto.randomUUID()}`
    );
    expect(
      await agentStub.driveStreamTextProviderErrorForTest(429, false)
    ).toBe("error");
  });

  it("leaves an error the provider says nothing about terminal", async () => {
    const agentStub = await getTestAgent(
      `provider-error-401-${crypto.randomUUID()}`
    );
    expect(
      await agentStub.driveFailingReaderTurnForTest("Invalid API key", 1, {
        statusCode: 401
      })
    ).toBe("error");
  });
});

describe("platform-transient reader errors (#1964)", () => {
  it("retries a dropped connection mid-stream inside the turn, which completes", async () => {
    const agentStub = await getTestAgent(
      `transient-reader-${crypto.randomUUID()}`
    );

    expect(
      await agentStub.driveFailingReaderTurnForTest("Network connection lost.")
    ).toBe("completed");

    const reply = await storedAssistantText(agentStub);
    expect(reply).toContain("partial before failure");
    expect(reply).toContain("Continued response.");
  });

  it.each([
    ["before the first chunk", "none", false],
    ["before the first chunk", "none", true],
    ["after a start-only chunk", "start-only", false],
    ["after a start-only chunk", "start-only", true]
  ] as const)(
    "re-runs a new turn that failed %s (prelude %s, prior assistant %s)",
    async (_when, prelude, priorAssistant) => {
      const agentStub = await getTestAgent(
        `transient-empty-${prelude}-${priorAssistant}-${crypto.randomUUID()}`
      );

      expect(
        await agentStub.driveFailingReaderTurnForTest(
          "Network connection lost.",
          1,
          { prelude, priorAssistant }
        )
      ).toBe("completed");

      type Stored = Array<{
        id: string;
        role: string;
        parts: Array<{ type: string; text?: string }>;
      }>;
      const textOf = (m: Stored[number]) =>
        m.parts.map((p) => p.text ?? "").join("");
      await expect
        .poll(
          async () => {
            const stored = (await agentStub.getPersistedMessages()) as Stored;
            const last = stored[stored.length - 1];
            return last?.role === "assistant" ? textOf(last) : "";
          },
          { timeout: 5000 }
        )
        .toBe("Continued response.");

      const stored = (await agentStub.getPersistedMessages()) as Stored;
      expect(stored.map((m) => m.role)).toEqual(
        priorAssistant
          ? ["user", "assistant", "user", "assistant"]
          : ["user", "assistant"]
      );
      if (priorAssistant) {
        expect(textOf(stored[1])).toBe("Earlier answer.");
      }
    }
  );

  it("honours onChatRecovery declining the continuation", async () => {
    const agentStub = await getTestAgent(
      `transient-declined-${crypto.randomUUID()}`
    );
    await agentStub.setRecoveryOverride({ continue: false });

    expect(
      await agentStub.driveFailingReaderTurnForTest("Network connection lost.")
    ).toBe("error");

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await agentStub.getFailingReaderCallsForTest()).toBe(1);
    expect(await agentStub.getOnChatMessageCallCount()).toBe(1);
  });

  it("passes what the turn stashed and its start time to onChatRecovery", async () => {
    const agentStub = await getTestAgent(
      `transient-context-${crypto.randomUUID()}`
    );
    await agentStub.setRecoveryOverride({ continue: false });
    await agentStub.setStashData({ responseId: "r-123" });
    const before = Date.now();

    expect(
      await agentStub.driveFailingReaderTurnForTest("Network connection lost.")
    ).toBe("error");

    const contexts = (await agentStub.getRecoveryContexts()) as Array<{
      recoveryData: unknown;
      createdAt: number;
    }>;
    expect(contexts).toHaveLength(1);
    expect(contexts[0].recoveryData).toEqual({ responseId: "r-123" });
    expect(contexts[0].createdAt).toBeGreaterThanOrEqual(before);
    // When the turn began, not when its recovery did.
    expect(contexts[0].createdAt).toBeLessThanOrEqual(Date.now());
  });

  it("ends a transient failure the app declines to continue as the stream error, and records it", async () => {
    const room = `transient-declined-record-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);
    await agentStub.setRecoveryOverride({ continue: false });

    expect(
      await agentStub.driveFailingReaderTurnForTest("Network connection lost.")
    ).toBe("error");

    // A tab that waited on it and was away learns what happened.
    const [requestId] = await agentStub.endedRequestIdsForTest();
    const asked = await endsOnReconnect(room, [requestId]);
    expect(asked.end).toMatchObject({
      id: requestId,
      done: true,
      error: true,
      body: "Network connection lost."
    });
  });

  it("exhausts repeated disconnects on the transient retry budget", async () => {
    const agentStub = await getTestAgent(
      `transient-budget-${crypto.randomUUID()}`
    );
    await agentStub.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    expect(
      await agentStub.driveFailingReaderTurnForTest(
        "Network connection lost.",
        10
      )
    ).toBe("error");

    // The first attempt and two recoveries of it: the budget.
    expect(await agentStub.getFailingReaderCallsForTest()).toBe(3);
  }, 20_000);

  it("keeps an application error terminal", async () => {
    const agentStub = await getTestAgent(
      `app-reader-error-${crypto.randomUUID()}`
    );
    expect(await agentStub.driveFailingReaderTurnForTest("boom")).toBe("error");
    expect(await agentStub.getChatRecoveryIncidentsForTest()).toHaveLength(0);
  });

  it("leaves a deploy reset to the restart's recovery", async () => {
    const agentStub = await getTestAgent(
      `deploy-reader-error-${crypto.randomUUID()}`
    );
    expect(
      await agentStub.driveFailingReaderTurnForTest(
        "Durable Object reset because its code was updated."
      )
    ).toBe("error");
    expect(await agentStub.getChatRecoveryIncidentsForTest()).toHaveLength(0);
  });

  type Stored = Array<{
    role: string;
    parts: Array<{ type: string; text?: string }>;
  }>;
  const textsOf = async (agentStub: ChatRecoveryTestStub) =>
    ((await agentStub.getPersistedMessages()) as Stored).map((m) =>
      m.parts.map((p) => p.text ?? "").join("")
    );

  it("drops the partial and retries the turn when onChatRecovery returns persist: false", async () => {
    const agentStub = await getTestAgent(
      `transient-no-persist-${crypto.randomUUID()}`
    );
    await agentStub.setRecoveryOverride({ persist: false });

    expect(
      await agentStub.driveFailingReaderTurnForTest("Network connection lost.")
    ).toBe("completed");

    expect(await textsOf(agentStub)).toEqual([
      "tell me a long story",
      "Continued response."
    ]);
  });

  it("drops an early-persisted approval request with the partial under persist: false", async () => {
    const agentStub = await getTestAgent(
      `transient-no-persist-approval-${crypto.randomUUID()}`
    );
    await agentStub.setRecoveryOverride({ persist: false });

    expect(
      await agentStub.driveFailingReaderTurnForTest(
        "Network connection lost.",
        1,
        { prelude: "approval" }
      )
    ).toBe("completed");

    expect(await textsOf(agentStub)).toEqual([
      "tell me a long story",
      "Continued response."
    ]);
    const stored = (await agentStub.getPersistedMessages()) as Stored;
    expect(
      stored
        .flatMap((m) => m.parts.map((p) => p.type))
        .filter((type) => type.startsWith("tool-"))
    ).toEqual([]);
  });

  it("completes after two transient failures in a row, and says the recovery completed", async () => {
    const room = `transient-chain-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);
    const events: string[] = [];
    const unsubscribe = subscribe("chat", (event) => {
      // Only this test's agent: the channel carries every agent's events,
      // and an earlier test's recovery can still be ending.
      if (event.name === room && event.type.startsWith("chat:recovery:")) {
        events.push(event.type);
      }
    });
    try {
      expect(
        await agentStub.driveFailingReaderTurnForTest(
          "Network connection lost.",
          2
        )
      ).toBe("completed");

      expect((await textsOf(agentStub)).at(-1)).toContain(
        "Continued response."
      );
      expect(await agentStub.getFailingReaderCallsForTest()).toBe(2);
      expect(events).not.toContain("chat:recovery:failed");
      expect(events.at(-1)).toBe("chat:recovery:completed");
    } finally {
      unsubscribe();
    }
  }, 20_000);

  it("ends the turn's run when the user stops it while it waits for its next attempt", async () => {
    const room = `transient-cancel-run-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);

    // The wait for the next attempt is a minute: only the stop can end it.
    const stoppedId = await agentStub.startFailingReaderTurnForTest(
      "Network connection lost.",
      1,
      HELD_BACKOFF
    );

    const { ws } = await connectChatWS(
      `/agents/chat-recovery-test-agent/${room}`
    );
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
        id: stoppedId
      })
    );
    // The stop ends the turn: its caller gets its result now, not in a
    // minute.
    expect(await agentStub.startedFailingTurnStatusForTest()).toBe("aborted");
    ws.close(1000);

    // Its run is gone (nothing holds the lane for a minute), and the model
    // was not asked again.
    expect(await agentStub.openChatLaneRunsForTest()).toBe(0);
    expect(await agentStub.getFailingReaderCallsForTest()).toBe(1);
  }, 30_000);

  // Replays of paths the chat recovery model (verify-chat) found.
  it("stops a turn the user cancels while its next attempt waits on the model", async () => {
    const room = `transient-cancel-running-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);

    // The first attempt is cut off; the next one starts three seconds later
    // and is held on the model.
    const stoppedId = await agentStub.startFailingReaderTurnForTest(
      "Network connection lost.",
      1,
      { responseHeaders: { "retry-after": "3" }, waitsAtLeastMs: 1_000 }
    );
    await agentStub.holdNextTurnForTest();
    await expect
      .poll(() => agentStub.isTurnHeldForTest(), { timeout: 10_000 })
      .toBe(true);

    // A tab presses stop: it knows the turn by its request id.
    const { ws } = await connectChatWS(
      `/agents/chat-recovery-test-agent/${room}`
    );
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
        id: stoppedId
      })
    );
    await socketBarrier(ws, seenFrames(ws));
    // The model answers.
    await agentStub.releaseHeldTurnForTest();
    expect(await agentStub.startedFailingTurnStatusForTest()).toBe("aborted");
    ws.close(1000);

    // What the stopped attempt would have said is not in the reply.
    expect(await storedAssistantText(agentStub)).not.toContain(
      "Continued response."
    );
    expect(await agentStub.openChatLaneRunsForTest()).toBe(0);
  }, 20_000);

  it("abortAllRequests() stops a turn that waits for its next attempt", async () => {
    const room = `transient-stop-all-${crypto.randomUUID()}`;
    const agentStub = await getTestAgent(room);

    // The wait for the next attempt is a minute: only the stop can end it.
    await agentStub.startFailingReaderTurnForTest(
      "Network connection lost.",
      1,
      HELD_BACKOFF
    );

    // The app stops everything. No model call is running: the waiting turn
    // is all there is to stop.
    await agentStub.abortAllRequestsForTest();

    expect(await agentStub.startedFailingTurnStatusForTest()).toBe("aborted");
    expect(await agentStub.openChatLaneRunsForTest()).toBe(0);
    expect(await agentStub.getOnChatMessageCallCount()).toBe(1);
  }, 20_000);

  it.each([
    ["once", 1],
    ["again while it recovers", 2]
  ])(
    "answers a question sent while a turn waits for its next attempt after that turn's reply, cut off %s",
    async (_, cuts) => {
      const room = `transient-newer-question-${crypto.randomUUID()}`;
      const agentStub = await getTestAgent(room);

      // The first turn is cut off and waits a minute for its next attempt.
      // With two cuts, that attempt is cut off too and waits again.
      await agentStub.startFailingReaderTurnForTest(
        "Network connection lost.",
        cuts,
        HELD_BACKOFF
      );
      const stored = (await agentStub.getPersistedMessages()) as ChatMessage[];

      // A tab sends a second question during the wait. It waits in the lane
      // behind the first turn, which holds it (ChatOrder).
      const { ws } = await connectChatWS(
        `/agents/chat-recovery-test-agent/${room}`
      );
      const question: ChatMessage = {
        id: "user-second",
        role: "user",
        parts: [{ type: "text", text: "Never mind, something else" }]
      };
      let answered = false;
      ws.addEventListener("message", (event: MessageEvent) => {
        const frame = JSON.parse(event.data as string) as {
          type?: string;
          id?: string;
          done?: boolean;
        };
        if (
          frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          frame.id === "req-second" &&
          frame.done
        ) {
          answered = true;
        }
      });
      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
          id: "req-second",
          init: {
            method: "POST",
            body: JSON.stringify({ messages: [...stored, question] })
          }
        })
      );
      // The question is queued behind the turn whose recovery still backs
      // off: its lane run is open beside that turn's, and nothing ran.
      await vi.waitFor(
        async () => {
          expect(await agentStub.openChatLaneRunsForTest()).toBe(2);
        },
        { timeout: 10_000, interval: 20 }
      );
      expect(answered).toBe(false);
      expect(await agentStub.getOnChatMessageCallCount()).toBe(1);

      // Now the waits end, one for each cut: the first turn is finished,
      // and the question is answered after it.
      await vi.waitFor(
        async () => {
          await agentStub.endRetryWaitsForTest();
          expect(answered).toBe(true);
        },
        { timeout: 10_000, interval: 50 }
      );
      await agentStub.waitForIdleForTest();
      ws.close(1000);

      // The recovered reply comes first, then the question and its answer.
      const after = (await agentStub.getPersistedMessages()) as ChatMessage[];
      const at = after.findIndex((m) => m.id === "user-second");
      expect(at).toBeGreaterThan(0);
      expect(
        after
          .slice(0, at)
          .flatMap((m) => m.parts)
          .map((p) => (p as { text?: string }).text ?? "")
          .join("")
      ).toContain("Continued response.");
      expect(after.at(-1)?.role).toBe("assistant");
    },
    // Above the three bounded waits (10 s each) taken together.
    60_000
  );
});
