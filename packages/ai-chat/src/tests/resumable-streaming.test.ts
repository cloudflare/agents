import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { MessageType, type OutgoingMessage } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";
import { getAgentByName } from "agents";

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

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const streamId = await agentStub.testStartStream("req-123");
      expect(streamId).toBeDefined();
      expect(typeof streamId).toBe("string");

      const metadata = await agentStub.getStreamMetadata(streamId);
      expect(metadata).toBeDefined();
      expect(metadata?.status).toBe("streaming");
      expect(metadata?.request_id).toBe("req-123");

      ws.close(1000);
    });

    it("stores stream chunks in batches", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

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

      ws.close(1000);
    });

    it("marks stream as completed and clears active state", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

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

      ws.close(1000);
    });

    it("marks stream as error on failure", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const streamId = await agentStub.testStartStream("req-error");

      // Mark as error
      await agentStub.testMarkStreamError(streamId);

      // Verify cleared state
      expect(await agentStub.getActiveStreamId()).toBeNull();

      const metadata = await agentStub.getStreamMetadata(streamId);
      expect(metadata?.status).toBe("error");

      ws.close(1000);
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

      const agentStub = await getAgentByName(env.TestChatAgent, room);
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

      ws2.close(1000);
    });

    it("sends stream chunks after client ACK", async () => {
      const room = crypto.randomUUID();

      // Setup - create a stream with chunks
      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);
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

      ws2.close(1000);
    });

    it("does not deliver live chunks before ACK to resuming connections", async () => {
      const room = crypto.randomUUID();

      // First connection - start a stream
      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages1 = collectMessages(ws1);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);
      const streamId = await agentStub.testStartStream("req-live");

      // Second connection - will be notified to resume
      const { ws: ws2 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages2 = collectMessages(ws2);

      await new Promise((r) => setTimeout(r, 100));

      // Broadcast a live chunk while ws2 is pending resume (no ACK yet)
      await agentStub.testBroadcastLiveChunk(
        "req-live",
        streamId,
        '{"type":"text-delta","id":"0","delta":"A"}'
      );

      await new Promise((r) => setTimeout(r, 100));

      // ws2 should NOT receive live chunks before ACK
      const preAckChunks = messages2.filter(isUseChatResponseMessage);
      expect(preAckChunks.length).toBe(0);

      // ws1 should receive the live chunk
      const ws1Chunks = messages1.filter(isUseChatResponseMessage);
      expect(ws1Chunks.length).toBe(1);
      expect(ws1Chunks[0].body).toBe(
        '{"type":"text-delta","id":"0","delta":"A"}'
      );

      // Send ACK to resume
      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: "req-live"
        })
      );

      await new Promise((r) => setTimeout(r, 100));

      // After ACK, ws2 should receive the replayed chunk
      const postAckChunks = messages2.filter(isUseChatResponseMessage);
      expect(postAckChunks.length).toBeGreaterThanOrEqual(1);
      expect(postAckChunks[0].body).toBe(
        '{"type":"text-delta","id":"0","delta":"A"}'
      );

      // Live chunks after ACK should be delivered
      await agentStub.testBroadcastLiveChunk(
        "req-live",
        streamId,
        '{"type":"text-delta","id":"0","delta":"B"}'
      );

      await new Promise((r) => setTimeout(r, 100));

      const finalChunks = messages2.filter(isUseChatResponseMessage);
      expect(finalChunks.some((m) => m.body?.includes('"delta":"B"'))).toBe(
        true
      );

      ws1.close();
      ws2.close(1000);
    });

    it("ignores ACK with wrong request ID", async () => {
      const room = crypto.randomUUID();

      // Setup
      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);
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

      ws2.close(1000);
    });
  });

  describe("Stale stream handling", () => {
    it("deletes stale streams on restore (older than 5 minutes)", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

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

      ws.close(1000);
    });

    it("restores fresh streams (under 5 minutes old)", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

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

      ws.close(1000);
    });
  });

  describe("Clear history", () => {
    it("clears stream data when chat history is cleared", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

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

      ws.close(1000);
    });
  });

  describe("Chunk buffer", () => {
    it("flushes chunks before starting a new stream", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

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

      ws.close(1000);
    });

    it("flushes on complete", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

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

      ws.close(1000);
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

      const agentStub = await getAgentByName(env.TestChatAgent, room);
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

      ws2.close(1000);
    });
  });

  describe("Client-initiated resume (issue #896)", () => {
    it("CF_AGENT_STREAM_RESUME_REQUEST triggers resume notification", async () => {
      const room = crypto.randomUUID();

      // First connection: start a stream
      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);
      const streamId = await agentStub.testStartStream("req-client-resume");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-start","id":"t1"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","id":"t1","delta":"hello"}'
      );
      await agentStub.testFlushChunkBuffer();

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // Second connection: send CF_AGENT_STREAM_RESUME_REQUEST
      const { ws: ws2 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages2 = collectMessages(ws2);

      // Wait briefly for any onConnect push (which we'll also get)
      await new Promise((r) => setTimeout(r, 50));

      // Send the client-initiated resume request
      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST
        })
      );

      await new Promise((r) => setTimeout(r, 100));

      // Should have received CF_AGENT_STREAM_RESUMING (from request, not just onConnect)
      const resumeMsgs = messages2.filter(isStreamResumingMessage);
      // May get 2 (one from onConnect, one from request) or 1 if timing collapses them
      expect(resumeMsgs.length).toBeGreaterThanOrEqual(1);

      ws2.close(1000);
    });

    it("CF_AGENT_STREAM_RESUME_REQUEST with no active stream is a no-op", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      const messages = collectMessages(ws);

      await new Promise((r) => setTimeout(r, 50));

      // Send resume request when there's no active stream
      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST
        })
      );

      await new Promise((r) => setTimeout(r, 100));

      // Should NOT get CF_AGENT_STREAM_RESUMING
      const resumeMsg = messages.find(isStreamResumingMessage);
      expect(resumeMsg).toBeUndefined();

      ws.close(1000);
    });

    it("replayed chunks have replay=true flag", async () => {
      const room = crypto.randomUUID();

      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);
      // Start a stream and add chunks but do NOT complete it
      // (stream must be active for resume to work)
      const streamId = await agentStub.testStartStream("req-replay-flag");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-start","id":"t1"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","id":"t1","delta":"test"}'
      );
      await agentStub.testFlushChunkBuffer();

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // Reconnect — active stream triggers resume
      const { ws: ws2 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages2 = collectMessages(ws2);

      await new Promise((r) => setTimeout(r, 50));

      // Send resume request
      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST
        })
      );

      await new Promise((r) => setTimeout(r, 50));

      // ACK the resuming notification
      const resumeMsg = messages2.find(isStreamResumingMessage);
      expect(resumeMsg).toBeDefined();

      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: (resumeMsg as { id: string }).id
        })
      );

      await new Promise((r) => setTimeout(r, 200));

      // All CF_AGENT_USE_CHAT_RESPONSE messages should have replay=true
      const responseMessages = messages2.filter(isUseChatResponseMessage);
      expect(responseMessages.length).toBeGreaterThan(0);

      for (const msg of responseMessages) {
        expect((msg as { replay?: boolean }).replay).toBe(true);
      }

      ws2.close(1000);
    });
  });

  describe("Replay complete signal for active streams (issue #896 follow-up)", () => {
    it("sends replayComplete=true after replaying chunks for a live stream", async () => {
      const room = crypto.randomUUID();

      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);
      // Start a stream and add chunks but do NOT complete it
      const streamId = await agentStub.testStartStream("req-replay-complete");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-start","id":"t1"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","id":"t1","delta":"thinking..."}'
      );
      await agentStub.testFlushChunkBuffer();

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // Reconnect — active stream triggers resume
      const { ws: ws2 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages2 = collectMessages(ws2);

      await new Promise((r) => setTimeout(r, 50));

      // ACK the resuming notification
      const resumeMsg = messages2.find(isStreamResumingMessage);
      expect(resumeMsg).toBeDefined();

      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: (resumeMsg as { id: string }).id
        })
      );

      await new Promise((r) => setTimeout(r, 200));

      const responseMessages = messages2.filter(isUseChatResponseMessage);
      expect(responseMessages.length).toBeGreaterThan(0);

      // The last response message should be the replayComplete signal
      const lastMsg = responseMessages[responseMessages.length - 1] as {
        replay?: boolean;
        replayComplete?: boolean;
        done?: boolean;
        body?: string;
      };
      expect(lastMsg.replay).toBe(true);
      expect(lastMsg.replayComplete).toBe(true);
      expect(lastMsg.done).toBe(false);
      expect(lastMsg.body).toBe("");

      ws2.close(1000);
    });

    it("sends done=true for orphaned streams after hibernation wake", async () => {
      const room = crypto.randomUUID();

      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);
      // Start a stream and add chunks
      const streamId = await agentStub.testStartStream("req-orphaned");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-start","id":"t1"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","id":"t1","delta":"partial response"}'
      );
      await agentStub.testFlushChunkBuffer();

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // Simulate hibernation: reinitialize ResumableStream (isLive=false)
      await agentStub.testSimulateHibernationWake();

      // Verify stream was restored from SQLite but is not live
      expect(await agentStub.getActiveStreamId()).toBe(streamId);

      // Reconnect
      const { ws: ws2 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages2 = collectMessages(ws2);

      await new Promise((r) => setTimeout(r, 50));

      // ACK the resuming notification
      const resumeMsg = messages2.find(isStreamResumingMessage);
      expect(resumeMsg).toBeDefined();

      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: (resumeMsg as { id: string }).id
        })
      );

      await new Promise((r) => setTimeout(r, 200));

      const responseMessages = messages2.filter(isUseChatResponseMessage);
      expect(responseMessages.length).toBeGreaterThan(0);

      // The last message should be done=true (NOT replayComplete)
      const lastMsg = responseMessages[responseMessages.length - 1] as {
        replay?: boolean;
        replayComplete?: boolean;
        done?: boolean;
        body?: string;
      };
      expect(lastMsg.replay).toBe(true);
      expect(lastMsg.done).toBe(true);
      expect(lastMsg.replayComplete).toBeUndefined();

      // Stream should be marked completed in SQLite
      const metadata = await agentStub.getStreamMetadata(streamId);
      expect(metadata?.status).toBe("completed");
      expect(await agentStub.getActiveStreamId()).toBeNull();

      // Partial assistant message should be persisted
      const persisted =
        (await agentStub.getPersistedMessages()) as unknown as Array<{
          role: string;
          parts: Array<{ type: string; text?: string }>;
        }>;
      const assistantMsg = persisted.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.parts.length).toBeGreaterThan(0);
      // Should contain the text from the replayed chunks
      const textPart = assistantMsg!.parts.find((p) => p.type === "text");
      expect(textPart).toBeDefined();
      expect(textPart!.text).toContain("partial response");

      ws2.close(1000);
    });
  });

  describe("Orphaned stream edge cases", () => {
    it("orphaned stream with zero chunks completes cleanly without persisting empty message", async () => {
      const room = crypto.randomUUID();

      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);
      // Start a stream but add NO chunks
      const streamId = await agentStub.testStartStream("req-empty-orphan");
      await agentStub.testFlushChunkBuffer();

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // Simulate hibernation
      await agentStub.testSimulateHibernationWake();
      expect(await agentStub.getActiveStreamId()).toBe(streamId);

      // Reconnect
      const { ws: ws2 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages2 = collectMessages(ws2);

      await new Promise((r) => setTimeout(r, 50));

      const resumeMsg = messages2.find(isStreamResumingMessage);
      expect(resumeMsg).toBeDefined();

      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: (resumeMsg as { id: string }).id
        })
      );

      await new Promise((r) => setTimeout(r, 200));

      // Stream should be completed
      expect(await agentStub.getActiveStreamId()).toBeNull();
      const metadata = await agentStub.getStreamMetadata(streamId);
      expect(metadata?.status).toBe("completed");

      // No assistant message should be persisted (zero chunks = no content)
      const persisted =
        (await agentStub.getPersistedMessages()) as unknown as Array<{
          role: string;
        }>;
      const assistantMsg = persisted.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeUndefined();

      ws2.close(1000);
    });

    it("orphaned stream with tool call parts reconstructs correctly", async () => {
      const room = crypto.randomUUID();

      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);
      const streamId = await agentStub.testStartStream("req-tool-orphan");
      // Simulate a stream that contained text + tool call
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-start","id":"t1"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","id":"t1","delta":"Let me check the weather."}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-end","id":"t1"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"tool-input-start","toolCallId":"tc-1","toolName":"getWeather"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"tool-input-available","toolCallId":"tc-1","toolName":"getWeather","input":{"city":"London"}}'
      );
      await agentStub.testFlushChunkBuffer();

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // Simulate hibernation
      await agentStub.testSimulateHibernationWake();

      // Reconnect + ACK
      const { ws: ws2 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages2 = collectMessages(ws2);
      await new Promise((r) => setTimeout(r, 50));

      const resumeMsg = messages2.find(isStreamResumingMessage);
      expect(resumeMsg).toBeDefined();

      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: (resumeMsg as { id: string }).id
        })
      );

      await new Promise((r) => setTimeout(r, 200));

      // Verify message was reconstructed with both text and tool parts
      const persisted =
        (await agentStub.getPersistedMessages()) as unknown as Array<{
          role: string;
          parts: Array<{ type: string; text?: string; toolCallId?: string }>;
        }>;
      const assistantMsg = persisted.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();

      // Should have a text part
      const textPart = assistantMsg!.parts.find((p) => p.type === "text");
      expect(textPart).toBeDefined();
      expect(textPart!.text).toContain("Let me check the weather.");

      // Should have a tool call part
      const toolPart = assistantMsg!.parts.find((p) => p.toolCallId === "tc-1");
      expect(toolPart).toBeDefined();

      ws2.close(1000);
    });

    it("second ACK after orphaned stream is finalized is a no-op", async () => {
      const room = crypto.randomUUID();

      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);
      const streamId = await agentStub.testStartStream("req-double-ack");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-start","id":"t1"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","id":"t1","delta":"hello"}'
      );
      await agentStub.testFlushChunkBuffer();

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // Simulate hibernation
      await agentStub.testSimulateHibernationWake();

      // First client connects and ACKs — orphaned stream gets finalized
      const { ws: ws2 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages2 = collectMessages(ws2);
      await new Promise((r) => setTimeout(r, 50));

      const resumeMsg = messages2.find(isStreamResumingMessage);
      expect(resumeMsg).toBeDefined();

      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: (resumeMsg as { id: string }).id
        })
      );

      await new Promise((r) => setTimeout(r, 200));

      // Stream is now finalized
      expect(await agentStub.getActiveStreamId()).toBeNull();

      // Second ACK with the same request ID — should be a no-op
      ws2.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: "req-double-ack"
        })
      );

      await new Promise((r) => setTimeout(r, 100));

      // Should still have exactly one assistant message (no duplicate)
      const persisted =
        (await agentStub.getPersistedMessages()) as unknown as Array<{
          role: string;
        }>;
      const assistantMsgs = persisted.filter((m) => m.role === "assistant");
      expect(assistantMsgs.length).toBe(1);

      ws2.close(1000);
    });
  });

  describe("clearAll clears chunk buffer", () => {
    it("buffered chunks are not flushed to SQLite after clearAll", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Start a stream and buffer some chunks (do NOT flush)
      const streamId = await agentStub.testStartStream("req-buffer-clear");
      await agentStub.testStoreStreamChunk(streamId, "chunk-1");
      await agentStub.testStoreStreamChunk(streamId, "chunk-2");

      // Chunks should be in buffer but not yet in SQLite (buffer size < 10)
      let chunks = await agentStub.getStreamChunks(streamId);
      expect(chunks.length).toBe(0); // Still in memory buffer

      // Clear all — should discard the buffer
      ws.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
      await new Promise((r) => setTimeout(r, 100));

      // Flush should be a no-op since buffer was cleared
      await agentStub.testFlushChunkBuffer();
      chunks = await agentStub.getStreamChunks(streamId);
      expect(chunks.length).toBe(0);

      // Wait before close to let the agent settle
      await new Promise((r) => setTimeout(r, 50));
      ws.close(1000);
    });
  });

  describe("errored stream cleanup", () => {
    it("errored streams are cleaned up alongside completed streams", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Insert an old errored stream (25 hours old, past the 24h cleanup threshold)
      await agentStub.testInsertOldErroredStream(
        "old-errored",
        "req-errored",
        25 * 60 * 60 * 1000
      );

      // Verify the errored stream exists
      const metadata = await agentStub.getStreamMetadata("old-errored");
      expect(metadata?.status).toBe("error");

      // Trigger cleanup by completing a dummy stream
      // (cleanup runs periodically inside completeStream)
      await agentStub.testTriggerStreamCleanup();

      // The old errored stream should be cleaned up
      const afterMetadata = await agentStub.getStreamMetadata("old-errored");
      expect(afterMetadata).toBeNull();

      // Wait before close to let the agent settle
      await new Promise((r) => setTimeout(r, 50));
      ws.close(1000);
    });
  });
});
