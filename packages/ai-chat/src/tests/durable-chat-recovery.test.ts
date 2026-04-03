import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage as ChatMessage } from "ai";

interface DurableChatTestStub {
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
}

async function getTestAgent(room: string): Promise<DurableChatTestStub> {
  const stub = await getAgentByName(env.DurableChatTestAgent, room);
  return stub as unknown as DurableChatTestStub;
}

describe("withDurableChat onChatRecovery", () => {
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

    await agentStub.insertInterruptedStream(
      "stream-stale",
      "req-stale",
      makeChunks(["Stale content"]),
      10 * 60 * 1000
    );
    await agentStub.triggerInterruptedStreamCheck();

    const contexts = (await agentStub.getRecoveryContexts()) as Array<{
      streamId: string;
      partialText: string;
    }>;

    expect(contexts).toHaveLength(1);
    expect(contexts[0].partialText).toBe("Stale content");
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
});
