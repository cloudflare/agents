import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage as ChatMessage } from "ai";

describe("withDurableChat stream recovery", () => {
  it("should fire onStreamInterrupted for an orphaned stream", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.DurableChatTestAgent, room);

    const streamId = "test-stream-interrupted";
    const requestId = "test-request-1";
    const chunks = [
      { body: JSON.stringify({ type: "text-start" }), index: 0 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Hello " }),
        index: 1
      },
      {
        body: JSON.stringify({ type: "text-delta", delta: "world" }),
        index: 2
      }
    ];

    await agentStub.insertInterruptedStream(streamId, requestId, chunks);
    await agentStub.triggerInterruptedStreamCheck();

    const contexts = (await agentStub.getInterruptedContexts()) as Array<{
      streamId: string;
      requestId: string;
      partialText: string;
      partialParts: unknown[];
    }>;

    expect(contexts.length).toBe(1);
    expect(contexts[0].streamId).toBe(streamId);
    expect(contexts[0].requestId).toBe(requestId);
    expect(contexts[0].partialText).toBe("Hello world");
    expect(contexts[0].partialParts.length).toBeGreaterThan(0);
  });

  it("should fire onStreamInterrupted for stale streams (>5min)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.DurableChatTestAgent, room);

    const streamId = "test-stream-stale";
    const requestId = "test-request-stale";
    const chunks = [
      { body: JSON.stringify({ type: "text-start" }), index: 0 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Stale content" }),
        index: 1
      }
    ];

    // 10-minute age — past the 5-minute stale threshold
    await agentStub.insertInterruptedStream(
      streamId,
      requestId,
      chunks,
      10 * 60 * 1000
    );
    await agentStub.triggerInterruptedStreamCheck();

    const contexts = (await agentStub.getInterruptedContexts()) as Array<{
      streamId: string;
      partialText: string;
    }>;

    expect(contexts.length).toBe(1);
    expect(contexts[0].streamId).toBe(streamId);
    expect(contexts[0].partialText).toBe("Stale content");
  });

  it("should extract partial text from stored chunks", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.DurableChatTestAgent, room);

    const streamId = "test-stream-partial";
    const requestId = "test-request-partial";
    const chunks = [
      { body: JSON.stringify({ type: "text-start" }), index: 0 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "First " }),
        index: 1
      },
      {
        body: JSON.stringify({ type: "text-delta", delta: "second " }),
        index: 2
      },
      {
        body: JSON.stringify({ type: "text-delta", delta: "third" }),
        index: 3
      },
      { body: JSON.stringify({ type: "text-end" }), index: 4 }
    ];

    await agentStub.insertInterruptedStream(streamId, requestId, chunks);

    const result = (await agentStub.getPartialText(streamId)) as {
      text: string;
      parts: unknown[];
    };

    expect(result.text).toBe("First second third");
    expect(result.parts.length).toBe(1);
  });

  it("should persist partial response via default onStreamInterrupted", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.DurableChatTestAgent, room);

    // Pre-populate a user message
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Tell me something" }]
      }
    ] as ChatMessage[]);

    const streamId = "test-stream-persist";
    const requestId = "test-request-persist";
    const messageId = "assistant-persist-1";
    const chunks = [
      { body: JSON.stringify({ type: "start", messageId }), index: 0 },
      { body: JSON.stringify({ type: "text-start" }), index: 1 },
      {
        body: JSON.stringify({
          type: "text-delta",
          delta: "Partial response"
        }),
        index: 2
      }
    ];

    await agentStub.insertInterruptedStream(streamId, requestId, chunks);
    await agentStub.triggerInterruptedStreamCheck();

    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = messages.filter(
      (m: ChatMessage) => m.role === "assistant"
    );

    expect(assistantMessages.length).toBe(1);
    expect(assistantMessages[0].id).toBe(messageId);

    const textParts = assistantMessages[0].parts.filter(
      (p: ChatMessage["parts"][number]) => p.type === "text"
    );
    expect(textParts.length).toBe(1);
    expect((textParts[0] as { text: string }).text).toBe("Partial response");
  });

  it("should return empty text when no stream exists", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.DurableChatTestAgent, room);

    const result = (await agentStub.getPartialText()) as {
      text: string;
      parts: unknown[];
    };

    expect(result.text).toBe("");
    expect(result.parts).toEqual([]);
  });

  it("should clean up interrupted stream after hook fires", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.DurableChatTestAgent, room);

    const streamId = "test-stream-cleanup";
    const requestId = "test-request-cleanup";
    const chunks = [
      { body: JSON.stringify({ type: "text-start" }), index: 0 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Cleaned up" }),
        index: 1
      }
    ];

    await agentStub.insertInterruptedStream(streamId, requestId, chunks);
    await agentStub.triggerInterruptedStreamCheck();

    // Hook should have fired
    const contexts = (await agentStub.getInterruptedContexts()) as Array<{
      streamId: string;
    }>;
    expect(contexts.length).toBe(1);
    expect(contexts[0].streamId).toBe(streamId);

    // Triggering check again should NOT fire the hook a second time
    // (stream was completed during cleanup)
    await agentStub.triggerInterruptedStreamCheck();

    const contextsAfter = (await agentStub.getInterruptedContexts()) as Array<{
      streamId: string;
    }>;
    expect(contextsAfter.length).toBe(1);
  });
});
