import { env } from "cloudflare:workers";
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

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
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

    it("records the allocated assistant message id in stream metadata for a real turn (#1691 wiring)", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      // Drive a real turn whose response carries NO provider `start.messageId`
      // (the common case — and the #1691 scenario). We assert that `_reply`
      // recorded the id it actually persists under (the id allocated at stream
      // start) in stream metadata, so orphan recovery can re-associate
      // reconstructed chunks with the right message. Without this wiring the
      // column would be null and recovery would fall back to the (buggy)
      // last-assistant heuristic.
      const done = new Promise<void>((resolve) => {
        ws.addEventListener("message", (e: MessageEvent) => {
          const data = JSON.parse(e.data as string);
          if (
            data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
            data.done
          ) {
            resolve();
          }
        });
      });

      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
          id: "req-wiring",
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: "u-wiring",
                  role: "user",
                  parts: [{ type: "text", text: "hi" }]
                }
              ]
            })
          }
        })
      );

      await done;

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Persistence runs after the `done` broadcast, so wait for the assistant
      // message to land before asserting.
      await waitFor(async () =>
        (
          (await agentStub.getPersistedMessages()) as Array<{ role: string }>
        ).some((m) => m.role === "assistant")
      );

      const persisted = (await agentStub.getPersistedMessages()) as Array<{
        id: string;
        role: string;
      }>;
      const assistant = persisted.find((m) => m.role === "assistant");
      expect(assistant).toBeDefined();

      const metadata = await agentStub.getAllStreamMetadata();
      const row = metadata.find((m) => m.request_id === "req-wiring");
      expect(row).toBeDefined();
      // The wiring: the metadata records the SAME id the assistant message was
      // persisted under (the allocated id, since no provider id was emitted).
      expect(row?.message_id).toBeTruthy();
      expect(row?.message_id).toBe(assistant?.id);

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

      await waitFor(
        () => messages2.filter(isUseChatResponseMessage).length >= 2
      );

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

      // Wait for the full round-trip: ACK delivery → server flushes chunk
      // buffer to SQLite → reads chunks → sends replay back to ws2.
      await waitFor(
        () => messages2.filter(isUseChatResponseMessage).length >= 1
      );

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

      await waitFor(() =>
        messages2
          .filter(isUseChatResponseMessage)
          .some((m) => m.body?.includes('"delta":"B"'))
      );

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
    it("restores stale streams instead of deleting them (lifecycle managed by fibers)", async () => {
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

      // Stale streams are now restored (not deleted) — fiber system handles lifecycle
      const afterRestore = await agentStub.getStreamMetadata(staleStreamId);
      expect(afterRestore).toBeDefined();

      // Active stream SHOULD be set (restored, not deleted)
      expect(await agentStub.getActiveStreamId()).toBe(staleStreamId);

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

    it("persists many chunks in order, packed into far fewer rows", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const streamId = await agentStub.testStartStream("req-batch");

      // 45 small chunks: auto-flushed every CHUNK_BUFFER_SIZE (10) → 4 packed
      // rows of 10, plus a manual flush of the remaining 5 → 5 rows total,
      // while all 45 chunks are still individually recoverable.
      const total = 45;
      for (let i = 0; i < total; i++) {
        await agentStub.testStoreStreamChunk(
          streamId,
          `{"type":"text","text":"c${i}"}`
        );
      }

      // Flush any remainder still in the buffer.
      await agentStub.testFlushChunkBuffer();

      const chunks = await agentStub.getStreamChunks(streamId);
      expect(chunks.length).toBe(total);
      for (let i = 0; i < total; i++) {
        expect(chunks[i].chunk_index).toBe(i);
        expect(chunks[i].body).toBe(`{"type":"text","text":"c${i}"}`);
      }

      // The 45 chunks are packed into 5 rows (4×10 + 1×5), not 45.
      const rowCount = await agentStub.getStreamChunkRowCount(streamId);
      expect(rowCount).toBe(5);

      ws.close(1000);
    });

    it("packs a single flush of multiple chunks into one row", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const streamId = await agentStub.testStartStream("req-pack-one");

      // 3 small chunks, then a manual flush → exactly one packed row.
      for (let i = 0; i < 3; i++) {
        await agentStub.testStoreStreamChunk(
          streamId,
          `{"type":"text","text":"p${i}"}`
        );
      }
      await agentStub.testFlushChunkBuffer();

      expect(await agentStub.getStreamChunkRowCount(streamId)).toBe(1);

      const chunks = await agentStub.getStreamChunks(streamId);
      expect(chunks.map((c) => c.body)).toEqual([
        '{"type":"text","text":"p0"}',
        '{"type":"text","text":"p1"}',
        '{"type":"text","text":"p2"}'
      ]);

      ws.close(1000);
    });

    it("stores a single buffered chunk as one unwrapped row", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const streamId = await agentStub.testStartStream("req-single");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"solo"}'
      );
      await agentStub.testFlushChunkBuffer();

      expect(await agentStub.getStreamChunkRowCount(streamId)).toBe(1);
      const chunks = await agentStub.getStreamChunks(streamId);
      expect(chunks.length).toBe(1);
      expect(chunks[0].body).toBe('{"type":"text","text":"solo"}');

      ws.close(1000);
    });

    it("splits a large chunk into its own row to respect the byte cap", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const streamId = await agentStub.testStartStream("req-bytecap");

      // A small chunk, then a chunk larger than SEGMENT_MAX_BYTES (512 KB),
      // then another small chunk. The large chunk forces a flush boundary on
      // each side, so it lands in its own (unwrapped) row.
      const big = "x".repeat(600_000);
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"before"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        `{"type":"text","text":"${big}"}`
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"after"}'
      );
      await agentStub.testFlushChunkBuffer();

      // 3 rows: [before], [big], [after] — the byte cap prevents packing the
      // large chunk with its neighbors.
      expect(await agentStub.getStreamChunkRowCount(streamId)).toBe(3);

      const chunks = await agentStub.getStreamChunks(streamId);
      expect(chunks.length).toBe(3);
      expect(chunks[0].body).toBe('{"type":"text","text":"before"}');
      expect(chunks[1].body).toBe(`{"type":"text","text":"${big}"}`);
      expect(chunks[2].body).toBe('{"type":"text","text":"after"}');

      ws.close(1000);
    });

    it("reads back legacy per-chunk rows (backward compatibility)", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Seed the table with legacy one-row-per-chunk records (unwrapped object
      // bodies), as written by older builds, then verify they unpack 1:1.
      const streamId = "legacy-stream";
      await agentStub.insertLegacyChunkRows(streamId, "req-legacy", [
        '{"type":"text","text":"L0"}',
        '{"type":"text","text":"L1"}',
        '{"type":"text","text":"L2"}'
      ]);

      // 3 legacy rows on disk…
      expect(await agentStub.getStreamChunkRowCount(streamId)).toBe(3);

      // …read back as 3 individual chunks in order.
      const chunks = await agentStub.getStreamChunks(streamId);
      expect(chunks.map((c) => c.body)).toEqual([
        '{"type":"text","text":"L0"}',
        '{"type":"text","text":"L1"}',
        '{"type":"text","text":"L2"}'
      ]);

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

    it("CF_AGENT_STREAM_RESUME_REQUEST with no active stream sends RESUME_NONE", async () => {
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

      await new Promise((r) => setTimeout(r, 500));

      // Should NOT get CF_AGENT_STREAM_RESUMING
      const resumeMsg = messages.find(isStreamResumingMessage);
      expect(resumeMsg).toBeUndefined();

      // Should get CF_AGENT_STREAM_RESUME_NONE
      const noneMsg = messages.find(
        (m) =>
          typeof m === "object" &&
          m !== null &&
          "type" in m &&
          m.type === MessageType.CF_AGENT_STREAM_RESUME_NONE
      );
      expect(noneMsg).toBeDefined();

      ws.close(1000);
    });

    it("replays stored chunks if the stream completes before the client ACK arrives", async () => {
      const room = crypto.randomUUID();
      const requestId = "req-late-ack-replay";

      const agentStub = await getAgentByName(env.TestChatAgent, room);
      const streamId = await agentStub.testStartStream(requestId);
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-start","id":"t1"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","id":"t1","delta":"hello after ack"}'
      );
      await agentStub.testFlushChunkBuffer();

      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      const messages = collectMessages(ws);

      await waitFor(
        () => messages.some((message) => isStreamResumingMessage(message)),
        1000
      );

      await agentStub.testCompleteStream(streamId);
      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: requestId
        })
      );

      await waitFor(
        () =>
          messages.some(
            (message) =>
              isUseChatResponseMessage(message) && message.done === true
          ),
        1000
      );

      const responseMessages = messages.filter(isUseChatResponseMessage);
      expect(responseMessages[0]).toEqual(
        expect.objectContaining({
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
          id: requestId,
          body: '{"type":"text-start","id":"t1"}',
          done: false,
          replay: true
        })
      );
      expect(responseMessages[1]).toEqual(
        expect.objectContaining({
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
          id: requestId,
          body: '{"type":"text-delta","id":"t1","delta":"hello after ack"}',
          done: false,
          replay: true
        })
      );
      expect(responseMessages.at(-1)).toEqual(
        expect.objectContaining({
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
          id: requestId,
          done: true,
          replay: true
        })
      );

      ws.close(1000);
    });

    it("does not replay stored chunks from an errored stream after a late ACK", async () => {
      const room = crypto.randomUUID();
      const requestId = "req-late-ack-error";

      const agentStub = await getAgentByName(env.TestChatAgent, room);
      const streamId = await agentStub.testStartStream(requestId);
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","delta":"should not replay"}'
      );
      await agentStub.testFlushChunkBuffer();

      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      const messages = collectMessages(ws);

      await waitFor(
        () => messages.some((message) => isStreamResumingMessage(message)),
        1000
      );

      await agentStub.testMarkStreamError(streamId);
      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: requestId
        })
      );

      await waitFor(
        () =>
          messages.some(
            (message) =>
              isUseChatResponseMessage(message) && message.done === true
          ),
        1000
      );

      const responseMessages = messages.filter(isUseChatResponseMessage);
      expect(
        responseMessages.some((message) =>
          message.body?.includes("should not replay")
        )
      ).toBe(false);
      expect(responseMessages).toEqual([
        expect.objectContaining({
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
          id: requestId,
          done: true,
          replay: true
        })
      ]);

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

      await waitFor(
        () => messages2.filter(isUseChatResponseMessage).length > 0
      );

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

      await waitFor(
        () => messages2.filter(isUseChatResponseMessage).length > 0
      );

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

      await waitFor(
        () => messages2.filter(isUseChatResponseMessage).length > 0
      );

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

      await waitFor(async () => (await agentStub.getActiveStreamId()) === null);

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

      await waitFor(async () => (await agentStub.getActiveStreamId()) === null);

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

    it("orphaned continuation stream merges into the existing assistant message", async () => {
      const room = crypto.randomUUID();

      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Pre-seed: user message + assistant with a tool call (simulates the
      // state just before a continuation starts).
      await agentStub.persistMessages([
        {
          id: "user-cont",
          role: "user",
          parts: [{ type: "text", text: "What is the weather?" }]
        },
        {
          id: "assistant-cont",
          role: "assistant",
          parts: [
            {
              type: "tool-getWeather" as `tool-${string}`,
              toolCallId: "tc-cont",
              state: "output-available",
              input: { city: "London" },
              output: { temp: 15 }
            }
          ]
        }
      ]);

      // Start a continuation stream whose start chunk has NO messageId
      // (stripped by #1229 server-side logic).
      const streamId = await agentStub.testStartStream("req-cont-orphan");
      await agentStub.testStoreStreamChunk(streamId, '{"type":"start"}');
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-start","id":"t-cont"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","id":"t-cont","delta":"The weather in London is 15°C."}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-end","id":"t-cont"}'
      );
      await agentStub.testFlushChunkBuffer();

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // Simulate hibernation — _resumableStream restores from SQLite,
      // but _isLive is false (no live LLM reader).
      await agentStub.testSimulateHibernationWake();

      // Reconnect + ACK triggers orphaned stream reconstruction
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

      await waitFor(async () => (await agentStub.getActiveStreamId()) === null);

      const persisted =
        (await agentStub.getPersistedMessages()) as unknown as Array<{
          id: string;
          role: string;
          parts: Array<{ type: string; text?: string; toolCallId?: string }>;
        }>;

      // Should still have exactly one assistant message (no duplicate)
      const assistantMessages = persisted.filter((m) => m.role === "assistant");
      expect(assistantMessages).toHaveLength(1);

      // It should reuse the original assistant message ID
      expect(assistantMessages[0].id).toBe("assistant-cont");

      // It should contain both the original tool part and the new text part
      const toolPart = assistantMessages[0].parts.find(
        (p) => p.toolCallId === "tc-cont"
      );
      expect(toolPart).toBeDefined();

      const textPart = assistantMessages[0].parts.find(
        (p) => p.type === "text"
      );
      expect(textPart).toBeDefined();
      expect(textPart!.text).toContain("15°C");

      ws2.close(1000);
    });

    it("orphaned continuation with no prior assistant message appends new message", async () => {
      const room = crypto.randomUUID();

      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Only a user message — no assistant message to merge into
      await agentStub.persistMessages([
        {
          id: "user-no-assistant",
          role: "user",
          parts: [{ type: "text", text: "Hello" }]
        }
      ]);

      // Continuation stream with no messageId in start chunk
      const streamId = await agentStub.testStartStream("req-no-assist");
      await agentStub.testStoreStreamChunk(streamId, '{"type":"start"}');
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-start","id":"t-na"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","id":"t-na","delta":"Reply"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-end","id":"t-na"}'
      );
      await agentStub.testFlushChunkBuffer();

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      await agentStub.testSimulateHibernationWake();

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

      await waitFor(async () => (await agentStub.getActiveStreamId()) === null);

      const persisted =
        (await agentStub.getPersistedMessages()) as unknown as Array<{
          id: string;
          role: string;
          parts: Array<{ type: string; text?: string }>;
        }>;

      // Should have user + new assistant (appended, not merged)
      expect(persisted).toHaveLength(2);
      expect(persisted[1].role).toBe("assistant");
      expect(persisted[1].parts.find((p) => p.type === "text")?.text).toContain(
        "Reply"
      );

      ws2.close(1000);
    });

    it("orphaned continuation merges metadata from existing assistant message", async () => {
      const room = crypto.randomUUID();

      const { ws: ws1 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      await agentStub.persistMessages([
        {
          id: "user-meta",
          role: "user",
          parts: [{ type: "text", text: "Hello" }]
        },
        {
          id: "assistant-meta",
          role: "assistant",
          parts: [
            {
              type: "tool-getWeather" as `tool-${string}`,
              toolCallId: "tc-meta",
              state: "output-available",
              input: { city: "Paris" },
              output: { temp: 20 }
            }
          ],
          metadata: { model: "test-model" }
        }
      ]);

      const streamId = await agentStub.testStartStream("req-meta-cont");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"start","messageMetadata":{"finishReason":"stop"}}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-start","id":"t-meta"}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","id":"t-meta","delta":"Done."}'
      );
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-end","id":"t-meta"}'
      );
      await agentStub.testFlushChunkBuffer();

      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      await agentStub.testSimulateHibernationWake();

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

      await waitFor(async () => (await agentStub.getActiveStreamId()) === null);

      const persisted =
        (await agentStub.getPersistedMessages()) as unknown as Array<{
          id: string;
          role: string;
          parts: Array<{ type: string }>;
          metadata?: Record<string, unknown>;
        }>;

      const assistant = persisted.find((m) => m.role === "assistant");
      expect(assistant).toBeDefined();
      expect(assistant!.id).toBe("assistant-meta");

      // Metadata should contain both the existing model and the stream's finishReason
      expect(assistant!.metadata).toMatchObject({
        model: "test-model",
        finishReason: "stop"
      });

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

      await waitFor(async () => (await agentStub.getActiveStreamId()) === null);

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

      // Insert an old errored stream (25 hours old, well past the completion grace)
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

    it("abandoned streaming rows are cleaned up after the stale-in-flight window", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Insert an old abandoned stream (25 hours old, still status "streaming")
      await agentStub.testInsertStaleStream(
        "abandoned-streaming",
        "req-abandoned",
        25 * 60 * 60 * 1000
      );

      const metadata = await agentStub.getStreamMetadata("abandoned-streaming");
      expect(metadata?.status).toBe("streaming");

      // Trigger cleanup
      await agentStub.testTriggerStreamCleanup();

      // The abandoned streaming row should be cleaned up
      const afterMetadata = await agentStub.getStreamMetadata(
        "abandoned-streaming"
      );
      expect(afterMetadata).toBeNull();

      await new Promise((r) => setTimeout(r, 50));
      ws.close(1000);
    });
  });

  describe("alarm-driven stream cleanup (#1706)", () => {
    it("arms a single cleanup alarm when a stream finishes, deduping repeats", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // No cleanup alarm before any stream finishes.
      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(0);

      // Finishing a stream arms exactly one cleanup alarm.
      await agentStub.testTriggerStreamCleanup();
      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(1);

      // Subsequent finishes collapse onto the same pending alarm (idempotent),
      // so DOs with many turns never accumulate cleanup schedules.
      await agentStub.testTriggerStreamCleanup();
      await agentStub.testTriggerStreamCleanup();
      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(1);

      await new Promise((r) => setTimeout(r, 50));
      ws.close(1000);
    });

    it("reclaims aged buffers when the alarm fires without a new stream completing", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // The exact #1706 scenario: a one-off chat whose buffers age out, with no
      // further stream ever completing to drive the lazy in-line sweep.
      await agentStub.testInsertOldErroredStream(
        "old-errored",
        "req-errored",
        25 * 60 * 60 * 1000
      );
      await agentStub.testInsertStaleStream(
        "abandoned-streaming",
        "req-abandoned",
        25 * 60 * 60 * 1000
      );

      // The alarm callback alone (no completeStream) reclaims both.
      await agentStub.testRunStreamCleanup();

      expect(await agentStub.getStreamMetadata("old-errored")).toBeNull();
      expect(
        await agentStub.getStreamMetadata("abandoned-streaming")
      ).toBeNull();

      await new Promise((r) => setTimeout(r, 50));
      ws.close(1000);
    });

    it("re-arms only while reclaimable buffers remain", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Fully-swept DO: running cleanup with nothing left does NOT re-arm, so an
      // idle/dead chat stops waking itself.
      await agentStub.testRunStreamCleanup();
      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(0);

      // A still-recent stream survives the sweep (not yet aged), so the DO must
      // keep an alarm pending to revisit it later.
      await agentStub.testInsertStaleStream(
        "recent-streaming",
        "req-recent",
        60 * 1000
      );
      await agentStub.testRunStreamCleanup();
      expect(
        await agentStub.getStreamMetadata("recent-streaming")
      ).not.toBeNull();
      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(1);

      await new Promise((r) => setTimeout(r, 50));
      ws.close(1000);
    });

    it("survives the real alarm fire and re-arms when a younger buffer remains", async () => {
      // Guards the idempotent-reschedule footgun: when the cleanup alarm fires,
      // `alarm()` deletes the fired one-shot row after the callback returns. An
      // idempotent re-arm would dedup onto that doomed row and vanish with it,
      // leaking any buffer that survived the sweep. The re-arm must be fresh.
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      await agentStub.testInsertStaleStream("young", "req-young", 60 * 1000);
      await agentStub.testArmStreamCleanup();
      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(1);

      // Fire the alarm for real — the fired row is deleted after the callback.
      await agentStub.testFireDueCleanupAlarm();

      // The young buffer survived the sweep, so a FRESH cleanup alarm must
      // remain pending (this is exactly 0 if the re-arm were idempotent).
      expect(await agentStub.getStreamMetadata("young")).not.toBeNull();
      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(1);

      await new Promise((r) => setTimeout(r, 50));
      ws.close(1000);
    });

    it("stops re-arming after the real alarm sweeps the last buffer", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      await agentStub.testInsertOldErroredStream(
        "old",
        "req-old",
        25 * 60 * 60 * 1000
      );
      await agentStub.testArmStreamCleanup();
      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(1);

      await agentStub.testFireDueCleanupAlarm();

      // Nothing reclaimable remains, so no re-arm: the DO stops waking itself.
      expect(await agentStub.getStreamMetadata("old")).toBeNull();
      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(0);

      await new Promise((r) => setTimeout(r, 50));
      ws.close(1000);
    });

    it("does not sweep a long-running stream that is still emitting chunks", async () => {
      // The abandoned-streaming sweep keys off LAST chunk activity, not start
      // time: a stream that began > 24h ago but is still writing chunks must
      // survive, while one that has been silent past the window is reclaimed.
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Started 25h ago but emitted a chunk a minute ago — still active.
      await agentStub.testInsertStaleStream(
        "long-active",
        "req-active",
        25 * 60 * 60 * 1000
      );
      await agentStub.testInsertStreamChunkAt("long-active", 60 * 1000);

      // Started 25h ago and went silent (last chunk 25h ago) — abandoned.
      await agentStub.testInsertStaleStream(
        "long-silent",
        "req-silent",
        25 * 60 * 60 * 1000
      );
      await agentStub.testInsertStreamChunkAt(
        "long-silent",
        25 * 60 * 60 * 1000
      );

      await agentStub.testRunStreamCleanup();

      expect(await agentStub.getStreamMetadata("long-active")).not.toBeNull();
      expect(await agentStub.getStreamMetadata("long-silent")).toBeNull();

      await new Promise((r) => setTimeout(r, 50));
      ws.close(1000);
    });

    it("arms cleanup when a stream starts (covers never-finished orphans)", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // No alarm yet on a fresh DO.
      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(0);

      // Starting a stream (without ever finishing it) must arm cleanup so an
      // evicted, never-resumed mid-stream orphan still gets a future sweep.
      await agentStub.testStartStream("req-orphan");
      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(1);

      await new Promise((r) => setTimeout(r, 50));
      ws.close(1000);
    });

    it("arms the cleanup alarm at the completion-grace delay (10 minutes)", async () => {
      // Locks the arming interval: a regression that lengthens it back toward
      // the old 24h window (re-introducing the #1706 leak) fails here.
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      await agentStub.testArmStreamCleanup();
      expect(await agentStub.testStreamCleanupScheduleDelaySeconds()).toBe(
        10 * 60
      );

      await new Promise((r) => setTimeout(r, 50));
      ws.close(1000);
    });

    it("sweeps a finished buffer past the 10-minute grace, keeps a recent one", async () => {
      // Completion retention is short: the assistant message is persisted
      // separately, so a finished buffer is only a brief replay grace.
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      await agentStub.testInsertOldErroredStream(
        "done-stale",
        "req-done-stale",
        11 * 60 * 1000
      );
      await agentStub.testInsertOldErroredStream(
        "done-recent",
        "req-done-recent",
        5 * 60 * 1000
      );

      await agentStub.testRunStreamCleanup();

      expect(await agentStub.getStreamMetadata("done-stale")).toBeNull();
      expect(await agentStub.getStreamMetadata("done-recent")).not.toBeNull();

      await new Promise((r) => setTimeout(r, 50));
      ws.close(1000);
    });

    it("keeps an abandoned in-flight buffer until the 1-hour stale window", async () => {
      // In-flight retention is generous so an interrupted turn has ample time
      // to be resumed or recovered before its buffer is presumed dead.
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      await agentStub.testInsertStaleStream(
        "inflight-recent",
        "req-inflight-recent",
        30 * 60 * 1000
      );
      await agentStub.testInsertStaleStream(
        "inflight-stale",
        "req-inflight-stale",
        70 * 60 * 1000
      );

      await agentStub.testRunStreamCleanup();

      expect(
        await agentStub.getStreamMetadata("inflight-recent")
      ).not.toBeNull();
      expect(await agentStub.getStreamMetadata("inflight-stale")).toBeNull();

      await new Promise((r) => setTimeout(r, 50));
      ws.close(1000);
    });

    it("keeps an in-flight buffer's chunks reconstructable past the completion grace", async () => {
      // Recovery reconstructs a partial assistant message from the stream
      // buffer (getStreamChunks / _persistOrphanedStream), and only ever does
      // so for an ACTIVE `streaming` row — which uses the generous 1h
      // last-activity window, NOT the 10min completion grace. A buffer whose
      // last chunk is older than the completion grace but within the in-flight
      // window must survive a sweep with its chunks intact, otherwise a turn
      // interrupted >10min could not be recovered.
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      await agentStub.testInsertStaleStream(
        "recovering",
        "req-recovering",
        30 * 60 * 1000
      );
      // Last chunk 20 minutes ago: past the 10min grace, within the 1h window.
      await agentStub.testInsertStreamChunkAt("recovering", 20 * 60 * 1000);

      await agentStub.testRunStreamCleanup();

      expect((await agentStub.getStreamMetadata("recovering"))?.status).toBe(
        "streaming"
      );
      expect(
        (await agentStub.getStreamChunks("recovering")).length
      ).toBeGreaterThan(0);

      await new Promise((r) => setTimeout(r, 50));
      ws.close(1000);
    });
  });
});
