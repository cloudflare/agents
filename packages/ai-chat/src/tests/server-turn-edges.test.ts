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
  ): Promise<{ requestId: string; status: string; reason?: string }>;
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

describe("a turn recovery finishes", () => {
  it("a turn that was cut off and recovered inside its run reports completed, not interrupted", async () => {
    const { stub } = await agent();
    await stub.armFailingReaderForTest("Network connection lost.");

    const result = await stub.saveSyntheticUserMessage("hello");

    // Nobody stopped it: recovery finishes the reply inside the same turn,
    // and the caller is told how the turn ended.
    expect(result).toMatchObject({ status: "completed" });
    expect(await stub.getOnChatMessageCallCount()).toBe(2);
    await stub.waitForIdleForTest();
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
