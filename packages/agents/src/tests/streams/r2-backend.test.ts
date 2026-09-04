import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { R2StreamHarnessObject } from "../capabilities/streams";
import { Streams, type StreamChunk } from "../../streams";

/**
 * Streams with the chunk log in R2 (`new Streams({ r2 })`): the public API
 * behaves exactly like the SQLite log — same cursors, replay, live tail,
 * settlement — while the chunks land in the bucket as one NDJSON file per
 * stream, checkpointed to a write-ahead log until the file is durable.
 */

async function collect(
  iterator: AsyncGenerator<StreamChunk, void, undefined>
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterator) chunks.push(chunk);
  return chunks;
}

async function objects(
  prefix: string
): Promise<{ key: string; size: number }[]> {
  const list = await env.STREAMS_R2.list({ prefix });
  return list.objects.map((o) => ({ key: o.key, size: o.size }));
}

async function fileLines(key: string): Promise<string[]> {
  const object = await env.STREAMS_R2.get(key);
  if (!object) return [];
  return (await object.text())
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Replay everything durable right now, without tailing a live stream. */
async function replayToTail(
  streams: Streams,
  streamId: string
): Promise<StreamChunk[]> {
  const abort = new AbortController();
  const chunks: StreamChunk[] = [];
  try {
    for await (const batch of streams.readBatches(streamId, {
      signal: abort.signal,
      onUpToDate: () => abort.abort(new Error("tail"))
    })) {
      chunks.push(...batch);
    }
  } catch (error) {
    if (!(error instanceof Error && error.message === "tail")) throw error;
  }
  return chunks;
}

function prefixOf(instance: R2StreamHarnessObject): string {
  return `t/${instance.ctx.id.toString().slice(0, 12)}/`;
}

describe("Streams on R2", () => {
  it("appends with a monotonic cursor, tails live, and lands one file at close", async () => {
    const stub = env.R2StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: R2StreamHarnessObject) => {
      const prefix = prefixOf(instance);
      const stream = await instance.streams.open("s1", {
        metadata: { topic: "demo" },
        tag: "req-1"
      });
      expect(stream.cursor).toBe(0);

      // A reader tailing from memory while the producer is live.
      const tail = collect(instance.streams.read("s1"));

      for (let i = 0; i < 60; i++) expect(stream.append({ i })).toBe(i);
      expect(stream.cursor).toBe(60);

      const live = await instance.streams.status("s1");
      expect(live).toMatchObject({
        state: "streaming",
        cursor: 60,
        tag: "req-1",
        metadata: { topic: "demo" }
      });
      // The WAL checkpoints every 25 chunks: two segments so far (the puts
      // are asynchronous; give them a tick to land).
      await new Promise((r) => setTimeout(r, 50));
      const wal = await objects(`${prefix}s1/seg/`);
      expect(wal.length).toBe(2);

      stream.close();
      // The row settles synchronously but only claims what R2 holds; the
      // final cursor lands with the settled body.
      expect((await instance.streams.status("s1"))?.state).toBe("completed");
      await instance.streams.flush("s1");
      const settled = await instance.streams.status("s1");
      expect(settled?.cursor).toBe(60);

      expect((await tail).map((c) => c.seq)).toEqual(
        Array.from({ length: 60 }, (_, i) => i)
      );

      await instance.streams.flush("s1");
      const lines = await fileLines(`${prefix}s1/body`);
      expect(lines.length).toBe(60);
      expect(JSON.parse(lines[59])).toEqual({ i: 59 });
      expect(await objects(`${prefix}s1/seg/`)).toEqual([]);

      // Replay after settlement comes from the file, not memory.
      const fromTen = await collect(instance.streams.read("s1", { from: 10 }));
      expect(fromTen.length).toBe(50);
      expect(fromTen[0]).toEqual({ seq: 10, chunk: { i: 10 } });

      expect(await instance.streams.list({ tag: "req-1" })).toHaveLength(1);
    });
  });

  it("keeps SQLite free of chunk rows", async () => {
    const stub = env.R2StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: R2StreamHarnessObject) => {
      const stream = await instance.streams.open("rows");
      for (let i = 0; i < 30; i++) stream.append({ i });
      stream.close();
      await instance.streams.flush();
      const tables = [
        ...instance.ctx.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_stream_chunks'"
        )
      ];
      const chunkRows =
        tables.length === 0
          ? 0
          : Number(
              [
                ...instance.ctx.storage.sql.exec(
                  "SELECT COUNT(*) AS n FROM cf_agents_stream_chunks"
                )
              ][0].n
            );
      expect(chunkRows).toBe(0);
      const row = [
        ...instance.ctx.storage.sql.exec(
          "SELECT chunk_count, state FROM cf_agents_streams WHERE stream_id = 'rows'"
        )
      ][0];
      expect(row).toEqual({ chunk_count: 30, state: "completed" });
    });
  });

  it("error() settles, still replays every chunk, and files the stream", async () => {
    const stub = env.R2StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: R2StreamHarnessObject) => {
      const prefix = prefixOf(instance);
      const stream = await instance.streams.open("err");
      for (let i = 0; i < 7; i++) stream.append(`c${i}`);
      stream.error("boom");
      expect(() => stream.append("late")).toThrow(/already settled/);
      await instance.streams.flush("err");
      const status = await instance.streams.status("err");
      expect(status).toMatchObject({
        state: "errored",
        error: "boom",
        cursor: 7
      });
      expect(await fileLines(`${prefix}err/body`)).toHaveLength(7);
      const replay = await collect(instance.streams.read("err"));
      expect(replay.map((c) => c.chunk)).toEqual(
        Array.from({ length: 7 }, (_, i) => `c${i}`)
      );
    });
  });

  it("resumes a stream whose producer died from the write-ahead log", async () => {
    const stub = env.R2StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: R2StreamHarnessObject) => {
      const prefix = prefixOf(instance);
      const first = await instance.streams.open("dead");
      for (let i = 0; i < 50; i++) first.append({ i });
      // Two checkpoints (50 chunks) are durable; nothing was settled. Let
      // the WAL puts land before we "lose" the isolate.
      await new Promise((r) => setTimeout(r, 50));
      expect(await objects(`${prefix}dead/seg/`)).toHaveLength(2);
      expect(await env.STREAMS_R2.head(`${prefix}dead/body`)).toBeNull();

      // A fresh Streams over the same storage and bucket is a restarted
      // isolate: the row is still `streaming`, the memory log is gone.
      const restarted = new Streams({
        r2: env.STREAMS_R2,
        r2Prefix: prefix,
        maxChunkBytes: 1024
      });
      // Borrow the harness's Lifecycle services by installing on a sibling
      // Lifecycle over the same DurableObject state.
      const { Lifecycle } = await import("../../lifecycle");
      const lifecycle = Lifecycle.install(instance).use(restarted);
      await lifecycle.start();

      expect((await restarted.status("dead"))?.cursor).toBe(50);
      const resumed = await restarted.open("dead");
      expect(resumed.cursor).toBe(50);
      for (let i = 50; i < 55; i++) expect(resumed.append({ i })).toBe(i);
      resumed.close();
      await restarted.flush("dead");

      const lines = await fileLines(`${prefix}dead/body`);
      expect(lines.length).toBe(55);
      expect(JSON.parse(lines[0])).toEqual({ i: 0 });
      expect(JSON.parse(lines[54])).toEqual({ i: 54 });
      expect(await objects(`${prefix}dead/seg/`)).toEqual([]);
      const all = await collect(restarted.read("dead"));
      expect(all.map((c) => c.seq)).toEqual(
        Array.from({ length: 55 }, (_, i) => i)
      );
    });
  });

  it("a replay before recovery never pins a truncated log", async () => {
    const stub = env.R2StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: R2StreamHarnessObject) => {
      const prefix = prefixOf(instance);
      const first = await instance.streams.open("early");
      for (let i = 0; i < 50; i++) first.append({ i });
      await new Promise((r) => setTimeout(r, 50));

      const { Lifecycle } = await import("../../lifecycle");
      const restarted = new Streams({ r2: env.STREAMS_R2, r2Prefix: prefix });
      await Lifecycle.install(instance).use(restarted).start();

      // A reader arrives before the producer resumes: served from the
      // segments, then tailing (the row is still live), so stop at the tail.
      const early = await replayToTail(restarted, "early");
      expect(early.length).toBe(50);

      const resumed = await restarted.open("early");
      expect(resumed.cursor).toBe(50);
      for (let i = 50; i < 60; i++) resumed.append({ i });
      resumed.close();
      await restarted.flush("early");

      const all = await collect(restarted.read("early"));
      expect(all.length).toBe(60);
      expect(all[59].chunk).toEqual({ i: 59 });
      // Two epochs wrote segments; the settled body replaced them all.
      expect(await objects(`${prefix}early/seg/`)).toEqual([]);
    });
  });

  it("delete() removes the row, the file and the write-ahead log", async () => {
    const stub = env.R2StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: R2StreamHarnessObject) => {
      const prefix = prefixOf(instance);
      const stream = await instance.streams.open("gone");
      stream.append(1);
      stream.close();
      await instance.streams.flush("gone");
      expect(await env.STREAMS_R2.head(`${prefix}gone/body`)).not.toBeNull();
      expect(await instance.streams.delete("gone")).toBe(true);
      expect(await objects(`${prefix}gone`)).toEqual([]);
      expect(await instance.streams.status("gone")).toBeNull();
    });
  });

  it("SQLite read/write accounting per operation", async () => {
    const stub = env.R2StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: R2StreamHarnessObject) => {
      const sql = instance.ctx.storage.sql;
      const counters = { read: 0, written: 0 };
      const exec = sql.exec.bind(sql);
      // Count billed rows behind every statement Streams issues.
      // @ts-expect-error test instrumentation of the bound method
      sql.exec = (query: string, ...params: unknown[]) => {
        const cursor = exec(query, ...(params as never[]));
        const rows = [...cursor];
        counters.read += cursor.rowsRead;
        counters.written += cursor.rowsWritten;
        return {
          ...cursor,
          [Symbol.iterator]: () => rows[Symbol.iterator](),
          toArray: () => rows,
          rowsRead: cursor.rowsRead,
          rowsWritten: cursor.rowsWritten
        };
      };
      const measure = async (fn: () => unknown | Promise<unknown>) => {
        counters.read = 0;
        counters.written = 0;
        await fn();
        return { ...counters };
      };
      const stream = await instance.streams.open("acct", { tag: "t" });
      const appends = await measure(() => {
        for (let i = 0; i < 100; i++) stream.append({ i });
      });
      await new Promise((r) => setTimeout(r, 50)); // let checkpoints land
      const status = await measure(() => instance.streams.status("acct"));
      const byTag = await measure(() =>
        instance.streams.list({ tag: "t", limit: 1 })
      );
      const close = await measure(() => stream.close());
      await instance.streams.flush("acct");
      const replay = await measure(() =>
        collect(instance.streams.read("acct"))
      );
      console.log("R2 backend SQLite accounting", {
        appendsX100: appends,
        status,
        byTag,
        close,
        replay
      });
      // The hot path: 100 appends read and write nothing in SQLite.
      expect(appends).toEqual({ read: 0, written: 0 });
    });
  });

  it("refuses the synchronous SQLite aperture", async () => {
    const stub = env.R2StreamHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: R2StreamHarnessObject) => {
      expect(() => instance.streams.__DO_NOT_USE_WILL_BREAK__sync()).toThrow(
        /SQLite-only/
      );
    });
  });
});
