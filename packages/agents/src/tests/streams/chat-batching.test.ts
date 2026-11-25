import { describe, expect, it } from "vitest";
import { openChatLog } from "../shared/chat-log";
import type { SqlTaggedTemplate } from "../../chat";
import { Streams } from "../../streams";
import { withCapabilityHarness } from "../shared/capability-harness";

const BATCH = { maxChunks: 10, maxBytes: 512_000 };

/**
 * Chat's chunk packing lives in Streams' batched appends: each wire chunk
 * has its own seq, a flush is one row write, and a turn's flushes fill its
 * newest block, so a turn is one row per 256 KB to delete, as packed
 * segments were. The recovery work unit stays what a segment held.
 */

function sqlOf(storage: DurableObjectStorage): SqlTaggedTemplate {
  return <T>(strings: TemplateStringsArray, ...values: unknown[]) =>
    storage.sql
      .exec(strings.join("?"), ...(values as SqlStorageValue[]))
      .toArray() as T[];
}

function blocks(storage: DurableObjectStorage, streamId: string) {
  return storage.sql
    .exec<{ block: number; seq_from: number; seq_to: number }>(
      `SELECT block, seq_from, seq_to FROM cf_agents_stream_blocks
       WHERE stream_id = ? ORDER BY block`,
      streamId
    )
    .toArray();
}

/** Rows written by `fn`, as SQLite bills them. */
function rowsWrittenBy(storage: DurableObjectStorage, fn: () => void): number {
  const sql = storage.sql;
  const exec = sql.exec.bind(sql);
  const cursors: Array<{ rowsWritten: number }> = [];
  sql.exec = ((query: string, ...params: SqlStorageValue[]) => {
    const cursor = exec(query, ...params);
    cursors.push(cursor);
    return cursor;
  }) as typeof sql.exec;
  try {
    fn();
  } finally {
    sql.exec = exec;
  }
  return cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0);
}

describe("chat chunks on Streams' batched appends", () => {
  it("writes each flush in one row, filling the turn's newest block until 256 KB", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const { lifecycle, capability: streams } = install(new Streams());
      await lifecycle.start();
      const chat = openChatLog(streams, sqlOf(storage));
      const streamId = chat.start("req-1");

      const seqs: Array<number | undefined> = [];
      const written = rowsWrittenBy(storage, () => {
        for (let i = 0; i < 30; i++)
          seqs.push(chat.storeChunk(streamId, `c${i}`));
      });
      // Three flushes of ten chunks: three row writes, one block.
      expect(written).toBe(3);
      expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => i));
      expect(blocks(storage, streamId)).toEqual([
        { block: 0, seq_from: 0, seq_to: 30 }
      ]);

      // Chunks that take the block past 256 KB start the next one.
      const big = "x".repeat(100_000);
      for (let i = 0; i < 3; i++) chat.storeChunk(streamId, big);
      chat.flushBuffer();
      expect(blocks(storage, streamId).map((b) => b.block).length).toBe(2);

      expect(chat.getStreamChunks(streamId).map((c) => c.body)).toEqual([
        ...Array.from({ length: 30 }, (_, i) => `c${i}`),
        big,
        big,
        big
      ]);
    });
  });

  it("counts one recovery work unit per ten stored chunks, and a released stream's packed segments as they are", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const { lifecycle, capability: streams } = install(new Streams());
      await lifecycle.start();
      // A stream from a version that packed segments: three seqs, the
      // first two packed, holding 21 chunks.
      const sync = streams.__DO_NOT_USE_WILL_BREAK__sync();
      sync.importStream({
        streamId: "released",
        state: "streaming",
        tag: "req-0",
        metadata: { cfChat: 1 },
        chunkCount: 0,
        createdAt: 1,
        updatedAt: 1,
        closedAt: null
      });
      const packed = Array.from({ length: 10 }, (_, i) => `p${i}`);
      sync.importChunk("released", packed, 1);
      sync.importChunk("released", packed, 2);
      sync.importChunk("released", "last", 3);

      const chat = openChatLog(streams, sqlOf(storage));
      expect(chat.progressMarker()).toBe(3);
      expect(chat.getStreamChunks("released")).toHaveLength(21);
      chat.complete("released");

      const streamId = chat.start("req-1");
      for (let i = 0; i < 25; i++) chat.storeChunk(streamId, `c${i}`);
      // The start reclaimed the released stream: its three units retired.
      // Twenty chunks are stored (two units), five still buffered.
      expect(chat.progressMarker()).toBe(5);
      chat.flushBuffer();
      expect(chat.progressMarker()).toBe(6);
      chat.cutover(streamId, () => {});
      expect(chat.progressMarker()).toBe(6);
    });
  });

  it("deletes a discarded stream at cutover without settling its row first", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const { lifecycle, capability: streams } = install(new Streams());
      await lifecycle.start();
      storage.sql.exec("CREATE TABLE message (id TEXT)");
      const writer = await streams.open("turn");
      writer.append("a");
      writer.append("b");
      const written = rowsWrittenBy(storage, () =>
        writer.close({
          commit: () => {
            storage.sql.exec("INSERT INTO message VALUES ('m')");
          },
          discard: true
        })
      );
      // The message, the block and the stream row: no settle UPDATE.
      expect(written).toBe(3);
      expect(await streams.status("turn")).toBeNull();
      expect(storage.sql.exec("SELECT id FROM message").toArray()).toEqual([
        { id: "m" }
      ]);
    });
  });

  it("refuses an append from a discarding cutover's commit", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { lifecycle, capability: streams } = install(new Streams());
      await lifecycle.start();
      const writer = await streams.open("turn");
      writer.append("a");
      const sync = streams.__DO_NOT_USE_WILL_BREAK__sync();
      const refused: string[] = [];
      writer.close({
        commit: () => {
          for (const attempt of [
            () => writer.append("late"),
            () => sync.appendJson("turn", '"late"', 6, BATCH)
          ]) {
            try {
              attempt();
            } catch (error) {
              refused.push((error as Error).name);
            }
          }
        },
        discard: true
      });
      expect(refused).toEqual(["StreamClosedError", "StreamClosedError"]);
      expect(await streams.status("turn")).toBeNull();
    });
  });

  it("pages a replay of large chunks by size, not only by count", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const { lifecycle, capability: streams } = install(new Streams());
      await lifecycle.start();
      const chat = openChatLog(streams, sqlOf(storage));
      const streamId = chat.start("req-big");
      const big = "y".repeat(400_000);
      for (let i = 0; i < 6; i++) chat.storeChunk(streamId, big);
      chat.flushBuffer();
      const sync = streams.__DO_NOT_USE_WILL_BREAK__sync();
      // A page stops at the first chunk past the cap.
      expect(sync.readChunks(streamId, 0, 100, 1_000_000)).toHaveLength(3);
      expect(sync.readChunks(streamId, 0, 100)).toHaveLength(6);
      // The replay still reads every chunk, a page at a time.
      expect(chat.getStreamChunks(streamId)).toHaveLength(6);
    });
  });
});
