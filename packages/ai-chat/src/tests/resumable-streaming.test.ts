import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { MessageType, type OutgoingMessage } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";

function isStreamResumingMessage(
  m: unknown
): m is Extract<
  OutgoingMessage,
  { type: MessageType.CF_AGENT_STREAM_RESUMING }
> {
  return (
    typeof m === "object" &&
    m !== null &&
    "type" in m &&
    m.type === MessageType.CF_AGENT_STREAM_RESUMING
  );
}

function collectMessages(ws: WebSocket): unknown[] {
  const messages: unknown[] = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    try {
      messages.push(JSON.parse(e.data as string));
    } catch {
      messages.push(e.data);
    }
  });
  return messages;
}

describe("Resumable Streaming", () => {
  describe("Stream lifecycle", () => {
    it("stores stream metadata when starting a stream", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = env.TestChatAgent.get(
        env.TestChatAgent.idFromName(room)
      );

      const streamId = await agentStub.testStartStream("req-123");
      expect(streamId).toBeDefined();
      expect(typeof streamId).toBe("string");

      const metadata = await agentStub.getStreamMetadata(streamId);
      expect(metadata).toBeDefined();
      expect(metadata?.status).toBe("streaming");
      expect(metadata?.request_id).toBe("req-123");

      ws.close();
    });

    it("stores stream chunks in batches", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = env.TestChatAgent.get(
        env.TestChatAgent.idFromName(room)
      );

      const streamId = await agentStub.testStartStream("req-456");

      // Store several chunks
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"Hello"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":" world"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"!"}'
      );

      // Flush the buffer
      await agentStub.testFlushChunkBuffer();

      const chunks = await agentStub.getStreamChunks(streamId);
      expect(chunks.length).toBe(3);
      expect(chunks[0].chunk_index).toBe(0);
      expect(chunks[1].chunk_index).toBe(1);
      expect(chunks[2].chunk_index).toBe(2);
      expect(chunks[0].body).toBe('{"type":"text","text":"Hello"}');

      ws.close();
    });

    it("marks stream as completed and clears active state", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = env.TestChatAgent.get(
        env.TestChatAgent.idFromName(room)
      );

      const streamId = await agentStub.testStartStream("req-789");

      // Verify active state
      expect(await agentStub.getActiveStreamId()).toBe(streamId);
      expect(await agentStub.getActiveRequestId()).toBe("req-789");

      // Complete the stream
      await agentStub.testCompleteStream(streamId);

      // Verify cleared state
      expect(await agentStub.getActiveStreamId()).toBeNull();
      expect(await agentStub.getActiveRequestId()).toBeNull();

      const metadata = await agentStub.getStreamMetadata(streamId);
      expect(metadata?.status).toBe("completed");

      ws.close();
    });

    it("marks stream as error on failure", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = env.TestChatAgent.get(
        env.TestChatAgent.idFromName(room)
      );

      const streamId = await agentStub.testStartStream("req-error");

      // Mark as error
      await agentStub.testMarkStreamError(streamId);

      // Verify cleared state
      expect(await agentStub.getActiveStreamId()).toBeNull();

      const metadata = await agentStub.getStreamMetadata(streamId);
      expect(metadata?.status).toBe("error");

      ws.close();
    });
  });

  describe("Stream resumption", () => {
    it("notifies new connections about active streams", async () => {
      const room = crypto.randomUUID();

      // First connection - start a stream
      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = env.TestChatAgent.get(
        env.TestChatAgent.idFromName(room)
      );
      const streamId = await agentStub.testStartStream("req-resume");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"Hello"}'
      );
      await agentStub.testFlushChunkBuffer();

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // Second connection - should receive resume notification
      const { ws: ws2 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages2 = collectMessages(ws2);

      await new Promise((r) => setTimeout(r, 100));

      const resumeMsg = messages2.find(isStreamResumingMessage);
      expect(resumeMsg).toBeDefined();
      expect(resumeMsg?.id).toBe("req-resume");

      ws2.close();
    });

    it("sends stream chunks after client ACK", async () => {
      const room = crypto.randomUUID();

      // Setup - create a stream with chunks
      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = env.TestChatAgent.get(
        env.TestChatAgent.idFromName(room)
      );
      const streamId = await agentStub.testStartStream("req-ack");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"chunk1"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"chunk2"}'
      );
      await agentStub.testFlushChunkBuffer();

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // New connection
      const { ws: ws2 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages2 = collectMessages(ws2);

      await new Promise((r) => setTimeout(r, 100));

      // Send ACK
      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: "req-ack"
        })
      );

      await new Promise((r) => setTimeout(r, 100));

      // Should receive the chunks
      const chunkMsgs = messages2.filter(isUseChatResponseMessage);
      expect(chunkMsgs.length).toBeGreaterThanOrEqual(2);
      expect(chunkMsgs[0].body).toBe('{"type":"text","text":"chunk1"}');
      expect(chunkMsgs[1].body).toBe('{"type":"text","text":"chunk2"}');

      ws2.close();
    });

    it("ignores ACK with wrong request ID", async () => {
      const room = crypto.randomUUID();

      // Setup
      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = env.TestChatAgent.get(
        env.TestChatAgent.idFromName(room)
      );
      const streamId = await agentStub.testStartStream("req-correct");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"secret"}'
      );
      await agentStub.testFlushChunkBuffer();

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // New connection
      const { ws: ws2 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages2 = collectMessages(ws2);

      await new Promise((r) => setTimeout(r, 100));

      // Send ACK with wrong ID
      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: "req-wrong-id"
        })
      );

      await new Promise((r) => setTimeout(r, 100));

      // Should NOT receive chunks (only state/mcp messages)
      const chunkMsgs = messages2.filter(isUseChatResponseMessage);
      expect(chunkMsgs.length).toBe(0);

      ws2.close();
    });
  });

  describe("Stale stream handling", () => {
    it("deletes stale streams on restore (older than 5 minutes)", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = env.TestChatAgent.get(
        env.TestChatAgent.idFromName(room)
      );

      // Insert a stale stream (6 minutes old)
      const staleStreamId = "stale-stream-123";
      await agentStub.testInsertStaleStream(
        staleStreamId,
        "req-stale",
        6 * 60 * 1000
      );

      // Verify it exists
      const beforeRestore = await agentStub.getStreamMetadata(staleStreamId);
      expect(beforeRestore).toBeDefined();

      // Trigger restore
      await agentStub.testRestoreActiveStream();

      // Should be deleted
      const afterRestore = await agentStub.getStreamMetadata(staleStreamId);
      expect(afterRestore).toBeNull();

      // Active stream should NOT be set
      expect(await agentStub.getActiveStreamId()).toBeNull();

      ws.close();
    });

    it("restores fresh streams (under 5 minutes old)", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = env.TestChatAgent.get(
        env.TestChatAgent.idFromName(room)
      );

      // Insert a fresh stream (1 minute old)
      const freshStreamId = "fresh-stream-456";
      await agentStub.testInsertStaleStream(
        freshStreamId,
        "req-fresh",
        1 * 60 * 1000
      );

      // Clear any active state first
      const currentActive = await agentStub.getActiveStreamId();
      if (currentActive) {
        await agentStub.testCompleteStream(currentActive);
      }

      // Trigger restore
      await agentStub.testRestoreActiveStream();

      // Should be restored
      expect(await agentStub.getActiveStreamId()).toBe(freshStreamId);
      expect(await agentStub.getActiveRequestId()).toBe("req-fresh");

      ws.close();
    });
  });

  describe("Clear history", () => {
    it("clears stream data when chat history is cleared", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = env.TestChatAgent.get(
        env.TestChatAgent.idFromName(room)
      );

      // Create a stream with chunks
      const streamId = await agentStub.testStartStream("req-clear");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"data"}'
      );
      await agentStub.testFlushChunkBuffer();

      // Verify data exists
      const chunksBefore = await agentStub.getStreamChunks(streamId);
      expect(chunksBefore.length).toBe(1);

      // Clear history via WebSocket message
      ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));

      await new Promise((r) => setTimeout(r, 100));

      // Stream data should be cleared
      const chunksAfter = await agentStub.getStreamChunks(streamId);
      expect(chunksAfter.length).toBe(0);

      const metadataAfter = await agentStub.getStreamMetadata(streamId);
      expect(metadataAfter).toBeNull();

      // Active state should be cleared
      expect(await agentStub.getActiveStreamId()).toBeNull();

      ws.close();
    });
  });

  describe("Chunk buffer", () => {
    it("flushes chunks before starting a new stream", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = env.TestChatAgent.get(
        env.TestChatAgent.idFromName(room)
      );

      // Start first stream and add chunks without explicit flush
      const stream1 = await agentStub.testStartStream("req-1");
      await agentStub.testStoreStreamChunk(
        stream1,
        '{"type":"text","text":"s1c1"}'
      );
      await agentStub.testStoreStreamChunk(
        stream1,
        '{"type":"text","text":"s1c2"}'
      );

      // Start second stream - should flush first stream's chunks
      const stream2 = await agentStub.testStartStream("req-2");

      // First stream's chunks should be persisted
      const chunks1 = await agentStub.getStreamChunks(stream1);
      expect(chunks1.length).toBe(2);

      // Second stream is active
      expect(await agentStub.getActiveStreamId()).toBe(stream2);

      ws.close();
    });

    it("flushes on complete", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = env.TestChatAgent.get(
        env.TestChatAgent.idFromName(room)
      );

      const streamId = await agentStub.testStartStream("req-flush");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"final"}'
      );

      // Complete - should flush
      await agentStub.testCompleteStream(streamId);

      const chunks = await agentStub.getStreamChunks(streamId);
      expect(chunks.length).toBe(1);
      expect(chunks[0].body).toBe('{"type":"text","text":"final"}');

      ws.close();
    });
  });

  describe("Completed stream handling", () => {
    it("sends done signal for completed streams on resume", async () => {
      const room = crypto.randomUUID();

      // Setup - create and complete a stream
      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = env.TestChatAgent.get(
        env.TestChatAgent.idFromName(room)
      );
      const streamId = await agentStub.testStartStream("req-done");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"done"}'
      );
      await agentStub.testCompleteStream(streamId);

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // New connection - no resume notification since stream is completed
      const { ws: ws2 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages2 = collectMessages(ws2);

      await new Promise((r) => setTimeout(r, 100));

      // Should NOT get resume notification for completed stream
      const resumeMsg = messages2.find(isStreamResumingMessage);
      expect(resumeMsg).toBeUndefined();

      ws2.close();
    });
  });
});
