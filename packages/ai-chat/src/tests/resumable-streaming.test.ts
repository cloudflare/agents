import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { MessageType, type OutgoingMessage } from "../types";
import { connectChatWS, socketBarrier } from "./test-utils";
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

    it("rebuilds a cut-off continuation onto its message once, however often it is rebuilt", async () => {
      const agentStub = await getAgentByName(
        env.TestChatAgent,
        crypto.randomUUID()
      );
      expect(await agentStub.rebuildContinuedReplyTwiceForTest()).toEqual([
        "Before",
        "After"
      ]);
    });

    it("stores stream chunks in batches", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

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

    it("marks stream as error on failure", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

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

  describe("Stale stream handling", () => {
    it("restores stale streams instead of deleting them (lifecycle managed by fibers)", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

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
  });

  describe("Clear history", () => {
    it("clears stream data when chat history is cleared", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

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
      await waitFor(
        async () =>
          (await agentStub.handledMessageCountForTest(
            MessageType.CF_AGENT_CHAT_CLEAR
          )) === 1,
        5000
      );

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

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const streamId = await agentStub.testStartStream("req-batch");

      // 45 small chunks: auto-flushed every 10, plus a manual flush of the
      // remaining 5, while all 45 chunks are still individually recoverable.
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

      // The 45 chunks are written in five flushes (4×10 + 1×5), each one
      // row write, all into one block row, not 45.
      expect(await agentStub.getStreamChunkRowCount(streamId)).toBe(45);
      expect(await agentStub.getStreamBlockRowCount(streamId)).toBe(1);

      ws.close(1000);
    });

    it("writes no KV progress mirror when a stream is retired or credited", async () => {
      const room = crypto.randomUUID();
      const agentStub = await getAgentByName(env.TestChatAgent, room);
      expect(await agentStub.probeProgressMirrorForTest()).toBeUndefined();
    });

    it("packs a single flush of multiple chunks into one row", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const streamId = await agentStub.testStartStream("req-pack-one");

      // 3 small chunks, then a manual flush → one row holding three seqs.
      for (let i = 0; i < 3; i++) {
        await agentStub.testStoreStreamChunk(
          streamId,
          `{"type":"text","text":"p${i}"}`
        );
      }
      await agentStub.testFlushChunkBuffer();

      expect(await agentStub.getStreamBlockRowCount(streamId)).toBe(1);
      expect(await agentStub.getStreamChunkRowCount(streamId)).toBe(3);

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

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const streamId = await agentStub.testStartStream("req-bytecap");

      // A small chunk, then a chunk larger than the 512 KB batch limit,
      // then another small chunk. The large chunk passes the batch limit and
      // forces a flush; each chunk keeps its own seq.
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

      // Three seqs, one per chunk.
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

      const agentStub = await getAgentByName(env.TestChatAgent, room);
      const streamId = await agentStub.testStartStream("req-done");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text","text":"done"}'
      );
      await agentStub.testCompleteStream(streamId);

      ws1.close();

      // New connection - no resume notification since stream is completed
      const { ws: ws2 } = await connectChatWS(
        `/agents/test-chat-agent/${room}`
      );
      const messages2 = collectMessages(ws2);

      // Every frame the connect sent is in by the barrier's reply.
      await socketBarrier(ws2, messages2);

      // Should NOT get resume notification for completed stream
      const resumeMsg = messages2.find(isStreamResumingMessage);
      expect(resumeMsg).toBeUndefined();

      ws2.close(1000);
    });
  });

  describe("clearAll clears chunk buffer", () => {
    it("buffered chunks are not flushed to SQLite after clearAll", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

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
      await waitFor(
        async () =>
          (await agentStub.handledMessageCountForTest(
            "cf_agent_chat_clear"
          )) === 1,
        5000
      );

      // Flush should be a no-op since buffer was cleared
      await agentStub.testFlushChunkBuffer();
      chunks = await agentStub.getStreamChunks(streamId);
      expect(chunks.length).toBe(0);
      ws.close(1000);
    });
  });

  describe("errored stream cleanup", () => {
    it("errored streams are cleaned up alongside completed streams", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

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

      // Reclaim, as the next stream start does.
      await agentStub.testReclaimStreams();

      // The old errored stream should be cleaned up
      const afterMetadata = await agentStub.getStreamMetadata("old-errored");
      expect(afterMetadata).toBeNull();
      ws.close(1000);
    });

    it("abandoned streaming rows are cleaned up after the stale-in-flight window", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Insert an old abandoned stream (25 hours old, still status "streaming")
      await agentStub.testInsertStaleStream(
        "abandoned-streaming",
        "req-abandoned",
        25 * 60 * 60 * 1000
      );

      const metadata = await agentStub.getStreamMetadata("abandoned-streaming");
      expect(metadata?.status).toBe("streaming");

      // Reclaim, as the next stream start does.
      await agentStub.testReclaimStreams();

      // The abandoned streaming row should be cleaned up
      const afterMetadata = await agentStub.getStreamMetadata(
        "abandoned-streaming"
      );
      expect(afterMetadata).toBeNull();

      ws.close(1000);
    });
  });

  describe("stream reclaim (no cleanup alarm)", () => {
    it("never arms a cleanup alarm, before or after a turn", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      const agentStub = await getAgentByName(env.TestChatAgent, room);
      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(0);

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
          id: "req-no-alarm",
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: "u-1",
                  role: "user",
                  parts: [{ type: "text", text: "hi" }]
                }
              ]
            })
          }
        })
      );
      await done;
      await waitFor(async () =>
        (
          (await agentStub.getPersistedMessages()) as Array<{ role: string }>
        ).some((m) => m.role === "assistant")
      );
      // The cutover deleted the stream with the message write; no alarm.
      expect(await agentStub.getAllStreamMetadata()).toEqual([]);
      expect(await agentStub.testCountStreamCleanupSchedules()).toBe(0);
      ws.close(1000);
    });

    it("reclaims finished streams of any age and abandoned in-flight rows past the stale window", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      const agentStub = await getAgentByName(env.TestChatAgent, room);

      await agentStub.testInsertOldErroredStream("done-recent", "req-1", 5_000);
      await agentStub.testInsertStaleStream(
        "inflight-recent",
        "req-2",
        30 * 60 * 1000
      );
      await agentStub.testInsertStaleStream(
        "inflight-stale",
        "req-3",
        70 * 60 * 1000
      );

      expect(await agentStub.testReclaimStreams()).toBe(2);
      expect(await agentStub.getStreamMetadata("done-recent")).toBeNull();
      expect(await agentStub.getStreamMetadata("inflight-stale")).toBeNull();
      expect(
        (await agentStub.getStreamMetadata("inflight-recent"))?.status
      ).toBe("streaming");
      ws.close(1000);
    });

    it("does not reclaim a long-running stream that is still emitting chunks", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      const agentStub = await getAgentByName(env.TestChatAgent, room);

      await agentStub.testInsertStaleStream(
        "long-active",
        "req-a",
        25 * 60 * 60 * 1000
      );
      await agentStub.testInsertStreamChunkAt("long-active", 60 * 1000);
      await agentStub.testInsertStaleStream(
        "long-silent",
        "req-s",
        25 * 60 * 60 * 1000
      );
      await agentStub.testInsertStreamChunkAt(
        "long-silent",
        25 * 60 * 60 * 1000
      );

      await agentStub.testReclaimStreams();
      expect((await agentStub.getStreamMetadata("long-active"))?.status).toBe(
        "streaming"
      );
      expect(await agentStub.getStreamMetadata("long-silent")).toBeNull();
      ws.close(1000);
    });
  });
});
