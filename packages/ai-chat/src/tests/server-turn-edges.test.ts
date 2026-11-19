import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { MessageType } from "../types";
import { connectChatWS } from "./test-utils";

type Stub = {
  persistMessages(messages: unknown[]): Promise<void>;
  seedIncidentForTest(incident: Record<string, unknown>): Promise<void>;
  getIncidentForTest(
    incidentId: string
  ): Promise<{ status: string; reason?: string } | null>;
  endNextTurnBeforeReplyForTest(how: "nothing" | "throw"): Promise<void>;
  continueLastTurnForTest(): Promise<string>;
  getOnChatMessageCallCount(): Promise<number>;
  getOnChatMessageBodies(): Promise<Array<Record<string, unknown> | undefined>>;
  setRequestContextForTest(
    body: Record<string, unknown> | undefined,
    clientTools: Array<{ name: string }>
  ): Promise<void>;
  getStoredRequestContextForTest(): Promise<{
    body: Record<string, unknown> | null;
    clientTools: string[] | null;
  }>;
  startPinnedTurnForTest(body: Record<string, unknown>): Promise<void>;
  awaitPinnedTurnForTest(): Promise<string>;
  holdNextTurnForTest(): Promise<void>;
  isTurnHeldForTest(): Promise<boolean>;
  releaseHeldTurnForTest(): Promise<void>;
  waitForIdleForTest(): Promise<void>;
  clearDuringNextResponseHookForTest(): Promise<void>;
  saveSyntheticUserMessage(
    text: string
  ): Promise<{ requestId: string; status: string }>;
  getPersistedMessages(): Promise<unknown[]>;
  runChatRecoveryContinueDirectForTest(
    data: Record<string, unknown>
  ): Promise<void>;
  armFailingReaderForTest(message: string): Promise<void>;
};

async function agent(room = crypto.randomUUID()) {
  return {
    room,
    stub: (await getAgentByName(
      env.ChatRecoveryTestAgent,
      room
    )) as unknown as Stub
  };
}

const exchange = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "question" }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", text: "partial" }] }
];

function scheduledContinue(incidentId: string) {
  return {
    incidentId,
    requestId: `root-${incidentId}`,
    recoveryKind: "continue",
    attempt: 1,
    maxAttempts: 6,
    status: "scheduled",
    firstSeenAt: Date.now(),
    lastAttemptAt: Date.now(),
    scheduled: { callback: "_chatRecoveryContinue", targetMessageId: "a1" }
  };
}

describe("a continuation takes a reply over from its scheduled recovery", () => {
  it.each(["nothing", "throw"] as const)(
    "not when its onChatMessage ends before a reply (%s)",
    async (how) => {
      const { stub } = await agent();
      await stub.persistMessages(exchange);
      await stub.seedIncidentForTest(scheduledContinue("inc-open"));

      // The app continues the reply itself, and its model call fails or
      // returns nothing. The reply still needs its recovery.
      await stub.endNextTurnBeforeReplyForTest(how);
      await stub.continueLastTurnForTest();

      expect(await stub.getOnChatMessageCallCount()).toBe(1);
      expect(await stub.getIncidentForTest("inc-open")).toMatchObject({
        status: "scheduled"
      });
    }
  );

  it("once its onChatMessage returned a reply", async () => {
    const { stub } = await agent();
    await stub.persistMessages(exchange);
    await stub.seedIncidentForTest(scheduledContinue("inc-taken"));

    expect(await stub.continueLastTurnForTest()).toBe("completed");

    expect(await stub.getIncidentForTest("inc-taken")).toMatchObject({
      status: "skipped",
      reason: "continued_by_interaction"
    });
  });
});

describe("a turn that finished before a clear", () => {
  it("is completed when the clear lands while onChatResponse runs", async () => {
    const { stub } = await agent();
    await stub.clearDuringNextResponseHookForTest();

    // The reply was stored and onChatResponse was handed `completed`. The
    // clear came after.
    const result = await stub.saveSyntheticUserMessage("hello");

    expect(result.status).toBe("completed");
    expect(await stub.getOnChatMessageCallCount()).toBe(1);
  });
});

describe("a context pinned on a turn", () => {
  it("goes to onChatMessage and is never the stored context, also across a clear", async () => {
    const { room, stub } = await agent();
    await stub.setRequestContextForTest({ chat: true }, [{ name: "chatTool" }]);
    await stub.holdNextTurnForTest();
    await stub.startPinnedTurnForTest({ pinned: true });
    await expect
      .poll(() => stub.isTurnHeldForTest(), { timeout: 3000 })
      .toBe(true);

    // While the pinned turn runs, the chat's own context is untouched.
    expect(await stub.getOnChatMessageBodies()).toEqual([{ pinned: true }]);
    expect(await stub.getStoredRequestContextForTest()).toEqual({
      body: { chat: true },
      clientTools: ["chatTool"]
    });

    // The chat is cleared under the turn. Nothing puts the old context back.
    const { ws } = await connectChatWS(
      `/agents/chat-recovery-test-agent/${room}`
    );
    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await stub.releaseHeldTurnForTest();
    await stub.awaitPinnedTurnForTest();
    await stub.waitForIdleForTest();
    ws.close(1000);

    expect(await stub.getStoredRequestContextForTest()).toEqual({
      body: null,
      clientTools: null
    });
  });

  it("a recovered turn runs with the interrupted request's context and leaves the stored one", async () => {
    const { stub } = await agent();
    await stub.setRequestContextForTest({ chat: true }, [{ name: "chatTool" }]);
    await stub.persistMessages(exchange);
    await stub.seedIncidentForTest(scheduledContinue("inc-run"));

    // The interrupted turn was an agent-tool run's: its input was its body.
    await stub.runChatRecoveryContinueDirectForTest({
      incidentId: "inc-run",
      originalRequestId: "root-inc-run",
      targetAssistantId: "a1",
      lastBody: { agentToolInput: "the run's input" },
      lastClientTools: null
    });

    expect(await stub.getOnChatMessageBodies()).toEqual([
      { agentToolInput: "the run's input" }
    ]);
    // The chat's next turn does not inherit the run's input.
    expect(await stub.getStoredRequestContextForTest()).toEqual({
      body: { chat: true },
      clientTools: ["chatTool"]
    });
  });

  it("a pinned turn cut off mid-reply is recovered with its own context", async () => {
    const { stub } = await agent();
    await stub.setRequestContextForTest({ chat: true }, [{ name: "chatTool" }]);
    // The reader fails once: the turn is cut off and recovery is scheduled
    // from the live turn, not from a fiber snapshot.
    await stub.armFailingReaderForTest("Network connection lost.");
    await stub.startPinnedTurnForTest({ pinned: true });
    await stub.awaitPinnedTurnForTest();

    await expect
      .poll(() => stub.getOnChatMessageCallCount(), { timeout: 8000 })
      .toBe(2);
    await stub.waitForIdleForTest();
    expect(await stub.getOnChatMessageBodies()).toEqual([
      { pinned: true },
      { pinned: true }
    ]);
    expect(await stub.getStoredRequestContextForTest()).toEqual({
      body: { chat: true },
      clientTools: ["chatTool"]
    });
  });
});
