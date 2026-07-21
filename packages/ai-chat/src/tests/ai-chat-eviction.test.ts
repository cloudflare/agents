/**
 * Forced Durable Object eviction coverage for AIChatAgent.
 *
 * `evictDurableObject()` explicitly tears down the running test actor and, by
 * default, transfers accepted WebSockets. These tests verify reconstruction
 * from SQLite and that forced WebSocket transfer. They do not assert natural
 * idle hibernation, timer absence, or hibernation eligibility.
 */
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { UIMessage as ChatMessage } from "ai";
import { describe, expect, it } from "vitest";
import { MessageType, type OutgoingMessage } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";

function isStreamResumingMessage(
  message: unknown
): message is Extract<
  OutgoingMessage,
  { type: MessageType.CF_AGENT_STREAM_RESUMING }
> {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === MessageType.CF_AGENT_STREAM_RESUMING
  );
}

function collectMessages(ws: WebSocket): unknown[] {
  const messages: unknown[] = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    try {
      messages.push(JSON.parse(event.data as string));
    } catch {
      messages.push(event.data);
    }
  });
  return messages;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function stubFor(room: string) {
  return getAgentByName(env.TestChatAgent, room);
}

describe("AIChatAgent recovery after forced Durable Object eviction", () => {
  it("rebuilds its in-memory message array from SQLite", async () => {
    const stub = await stubFor(crypto.randomUUID());
    const messages: ChatMessage[] = [
      {
        id: "evict-user",
        role: "user",
        parts: [{ type: "text", text: "remember me" }]
      },
      {
        id: "evict-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "I will be restored" }]
      }
    ];

    await stub.persistMessages(messages);
    expect(
      ((await stub.getMessagesForTest()) as ChatMessage[]).map(
        (message) => message.id
      )
    ).toEqual(["evict-user", "evict-assistant"]);

    await evictDurableObject(stub);

    const restored = (await stub.getMessagesForTest()) as ChatMessage[];
    expect(restored).toEqual(messages);
    expect(await stub.getPersistedMessages()).toEqual(restored);
  });

  it("restores an active resumable stream and its chunks", async () => {
    const stub = await stubFor(crypto.randomUUID());
    const streamId = await stub.testStartStream("req-evict-resume");
    await stub.testStoreStreamChunk(streamId, '{"type":"text","text":"Hello"}');
    await stub.testStoreStreamChunk(
      streamId,
      '{"type":"text","text":" world"}'
    );
    await stub.testFlushChunkBuffer();

    await evictDurableObject(stub);

    expect(await stub.getActiveStreamId()).toBe(streamId);
    expect(await stub.getActiveRequestId()).toBe("req-evict-resume");
    expect(await stub.getStreamChunks(streamId)).toMatchObject([
      { body: '{"type":"text","text":"Hello"}' },
      { body: '{"type":"text","text":" world"}' }
    ]);
  });

  it("keeps the same WebSocket usable across forced eviction", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const received = collectMessages(ws);

    try {
      await waitFor(() => ws.readyState === WebSocket.OPEN);
      const stub = await stubFor(room);
      const streamId = await stub.testStartStream("req-live-eviction");
      await stub.testStoreStreamChunk(
        streamId,
        '{"type":"text-start","id":"t1"}'
      );
      await stub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","id":"t1","delta":"partial"}'
      );
      await stub.testFlushChunkBuffer();

      await evictDurableObject(stub);

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.send(
        JSON.stringify({ type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST })
      );
      await waitFor(() => received.some(isStreamResumingMessage));

      const resume = received.find(isStreamResumingMessage);
      expect(resume).toBeDefined();
      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: resume!.id
        })
      );

      await waitFor(() =>
        received.some(
          (message) =>
            isUseChatResponseMessage(message) &&
            (message as { done?: boolean }).done === true
        )
      );
      expect(await stub.getActiveStreamId()).toBeNull();

      const persisted = (await stub.getPersistedMessages()) as ChatMessage[];
      expect(JSON.stringify(persisted)).toContain("partial");
    } finally {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    }
  });

  it('closes live WebSockets with { webSockets: "close" }', async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    try {
      await waitFor(() => ws.readyState === WebSocket.OPEN);
      let sawClose = false;
      ws.addEventListener("close", () => {
        sawClose = true;
      });

      const stub = await stubFor(room);
      await evictDurableObject(stub, { webSockets: "close" });

      await waitFor(() => sawClose || ws.readyState !== WebSocket.OPEN);
      expect(sawClose).toBe(true);
      expect(ws.readyState).not.toBe(WebSocket.OPEN);

      await stub.persistMessages([
        {
          id: "post-close-evict",
          role: "user",
          parts: [{ type: "text", text: "still alive" }]
        }
      ]);
      expect(await stub.getPersistedMessages()).toEqual([
        expect.objectContaining({ id: "post-close-evict" })
      ]);
    } finally {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    }
  });
});
