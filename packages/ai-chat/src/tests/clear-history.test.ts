import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";

describe("Clear History", () => {
  it("clears all messages, stream data, and broadcasts to other connections", async () => {
    const room = crypto.randomUUID();
    const { ws: ws1 } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const { ws: ws2 } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Persist some messages
    const messages: ChatMessage[] = [
      {
        id: "clear-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "clear-2",
        role: "assistant",
        parts: [{ type: "text", text: "Hi" }]
      }
    ];
    await agentStub.persistMessages(messages);

    // Also create some stream data
    const streamId = await agentStub.testStartStream("req-clear-test");
    await agentStub.testStoreStreamChunk(
      streamId,
      '{"type":"text","text":"stream-data"}'
    );
    await agentStub.testFlushChunkBuffer();

    // Verify data exists before clear
    const beforeMessages = await agentStub.getPersistedMessages();
    expect((beforeMessages as ChatMessage[]).length).toBe(2);
    const beforeChunks = await agentStub.getStreamChunks(streamId);
    expect(beforeChunks.length).toBe(1);

    // Listen for clear broadcast on ws2
    let ws2ReceivedClear = false;
    ws2.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_CHAT_CLEAR) {
        ws2ReceivedClear = true;
      }
    });

    // Clear via ws1
    ws1.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));

    await new Promise((r) => setTimeout(r, 100));

    // Messages should be cleared
    const afterMessages = await agentStub.getPersistedMessages();
    expect((afterMessages as ChatMessage[]).length).toBe(0);

    // Stream data should be cleared
    const afterChunks = await agentStub.getStreamChunks(streamId);
    expect(afterChunks.length).toBe(0);
    const afterMeta = await agentStub.getStreamMetadata(streamId);
    expect(afterMeta).toBeNull();

    // Active stream state should be cleared
    expect(await agentStub.getActiveStreamId()).toBeNull();
    expect(await agentStub.getActiveRequestId()).toBeNull();

    // ws2 should have received the clear broadcast
    expect(ws2ReceivedClear).toBe(true);

    ws1.close();
    ws2.close(1000);
  });

  it("resets abort controllers when clearing history", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    await new Promise((r) => setTimeout(r, 50));

    // Start a request
    const userMessage: ChatMessage = {
      id: "msg-abort-1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });
    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    });

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-abort-1",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage] })
        }
      })
    );

    await donePromise;

    // Clear should not throw even with prior requests
    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));

    await new Promise((r) => setTimeout(r, 100));

    // Agent should be in clean state
    const agentStub = await getAgentByName(env.TestChatAgent, room);
    const afterMessages = await agentStub.getPersistedMessages();
    expect((afterMessages as ChatMessage[]).length).toBe(0);

    ws.close(1000);
  });
});
