import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CutoverHarnessObject } from "../capabilities/streams";
import type { StreamChunk } from "../../streams";

/**
 * Schema v1 → v2 is lazy: a stream's per-chunk rows fold into blocks the
 * first time the stream is touched, one stream at a time, and the legacy
 * table is dropped once it is empty. Startup never reads the whole log.
 */

function sqlOf(instance: CutoverHarnessObject): SqlStorage {
  return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
}

function count(instance: CutoverHarnessObject, query: string): number {
  return [...sqlOf(instance).exec(query)][0].n as number;
}

async function collect(
  iterator: AsyncGenerator<StreamChunk, void, undefined>
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterator) chunks.push(chunk);
  return chunks;
}

/** A v1 log: one stream row per stream, one chunk row per chunk. */
function seedV1(
  instance: CutoverHarnessObject,
  streams: Record<
    string,
    { state: "streaming" | "completed"; chunks: unknown[] }
  >
) {
  const sql = sqlOf(instance);
  sql.exec(`CREATE TABLE IF NOT EXISTS cf_agents_streams (
    stream_id TEXT PRIMARY KEY, state TEXT NOT NULL, tag TEXT, metadata TEXT,
    error_message TEXT, chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cf_agents_stream_chunks (
    stream_id TEXT NOT NULL, seq INTEGER NOT NULL, chunk TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (stream_id, seq)) WITHOUT ROWID`);
  for (const [id, { state, chunks }] of Object.entries(streams)) {
    sql.exec(
      `INSERT INTO cf_agents_streams
         (stream_id, state, chunk_count, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, 1, 1, ?)`,
      id,
      state,
      chunks.length,
      state === "completed" ? 2 : null
    );
    chunks.forEach((chunk, seq) => {
      sql.exec(
        "INSERT INTO cf_agents_stream_chunks (stream_id, seq, chunk, created_at) VALUES (?, ?, ?, ?)",
        id,
        seq,
        JSON.stringify(chunk),
        1000 + seq
      );
    });
  }
}

describe("v1 chunk rows fold into blocks lazily", () => {
  it("keeps the folded-away legacy table visible after a rolled-back cutover", async () => {
    const stub = env.CutoverHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: CutoverHarnessObject) => {
      const ctx = (instance as unknown as { ctx: DurableObjectState }).ctx;
      await ctx.storage.put("cf_agents:streams_schema_version", 1);
      // The one live stream holds the last v1 rows, so its fold drops the
      // legacy table — and a cutover is that stream's first touch.
      seedV1(instance, {
        live: { state: "streaming", chunks: ["a", "b", "c"] }
      });
      await instance.lifecycle.start();

      const writer = await instance.streams.open("live");
      expect(() =>
        writer.close({
          commit: () => {
            throw new Error("persist failed");
          },
          discard: true
        })
      ).toThrow("persist failed");

      // SQLite restored the legacy rows with the rollback; the capability
      // must still see them: the cursor, the next append, and a replay.
      expect(
        count(instance, "SELECT COUNT(*) AS n FROM cf_agents_stream_chunks")
      ).toBe(3);
      expect((await instance.streams.status("live"))?.cursor).toBe(3);
      expect(writer.append("d")).toBe(3);
      expect((await instance.streams.status("live"))?.cursor).toBe(4);
      writer.close();
      const chunks = await collect(instance.streams.read("live"));
      expect(chunks.map((c) => c.chunk)).toEqual(["a", "b", "c", "d"]);
    });
  });

  it("folds one stream on first touch and drops the table once empty", async () => {
    const stub = env.CutoverHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: CutoverHarnessObject) => {
      const ctx = (instance as unknown as { ctx: DurableObjectState }).ctx;
      await ctx.storage.put("cf_agents:streams_schema_version", 1);
      const big = "x".repeat(100 * 1024);
      seedV1(instance, {
        live: { state: "streaming", chunks: ["a", "b", "c"] },
        // ~100 KB chunks: three per 256 KB block ceiling → two blocks.
        done: {
          state: "completed",
          chunks: [0, 1, 2, 3].map((i) => `${i}:${big}`)
        },
        gone: { state: "completed", chunks: ["z"] }
      });
      await instance.lifecycle.start();

      // Startup folds nothing.
      expect(
        count(instance, "SELECT COUNT(*) AS n FROM cf_agents_stream_chunks")
      ).toBe(8);
      expect(
        count(instance, "SELECT COUNT(*) AS n FROM cf_agents_stream_blocks")
      ).toBe(0);

      // A read folds only its own stream, replays every chunk in order.
      const done = await collect(instance.streams.read("done"));
      expect(done.map((c) => (c.chunk as string).slice(0, 2))).toEqual([
        "0:",
        "1:",
        "2:",
        "3:"
      ]);
      expect(
        [
          ...sqlOf(instance).exec(
            "SELECT seq_from, seq_to FROM cf_agents_stream_blocks WHERE stream_id = 'done' ORDER BY block"
          )
        ].map((r) => [r.seq_from, r.seq_to])
      ).toEqual([
        [0, 2],
        [2, 4]
      ]);
      expect(
        count(
          instance,
          "SELECT COUNT(*) AS n FROM cf_agents_stream_chunks WHERE stream_id = 'done'"
        )
      ).toBe(0);
      expect(
        count(instance, "SELECT COUNT(*) AS n FROM cf_agents_stream_chunks")
      ).toBe(4);

      // An append continues the folded log: cursor follows the v1 rows.
      const writer = await instance.streams.open("live");
      expect(writer.cursor).toBe(3);
      expect(writer.append("d")).toBe(3);
      // The stream is live, so read one batch and stop at the tail.
      const live: unknown[] = [];
      for await (const batch of instance.streams.readBatches("live", {
        from: 1
      })) {
        live.push(...batch.map((c) => c.chunk));
        break;
      }
      expect(live).toEqual(["b", "c", "d"]);

      // A cutover on a live v1 stream is a fold inside the cutover transaction.
      let committed = 0;
      writer.close({
        commit: () => {
          committed++;
        },
        discard: true
      });
      expect(committed).toBe(1);
      expect(await instance.streams.status("live")).toBeNull();

      // Deleting an untouched stream drops its rows without folding; the
      // last legacy row gone drops the table.
      expect(await instance.streams.delete("gone")).toBe(true);
      expect([
        ...sqlOf(instance).exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_stream_chunks'"
        )
      ]).toEqual([]);
      expect((await instance.streams.status("done"))?.cursor).toBe(4);
    });
  });
});
