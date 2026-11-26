import { describe, expect, it } from "vitest";
import { Streams } from "../../streams";
import type { StreamChunk } from "../../streams";
import { withCapabilityHarness } from "../shared/capability-harness";
import { describeInstanceConformance } from "../shared/instance-conformance";

/**
 * More than one Streams in one object (INSTANCES.md, I2): a named instance
 * has its own tables, index and schema key; the default keeps today's.
 */

const BATCH = { maxChunks: 4, maxBytes: 1_000_000 };

async function collect(
  iterator: AsyncGenerator<StreamChunk, void, undefined>
): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of iterator) chunks.push(chunk.chunk);
  return chunks;
}

/** Append `n` chunks through the buffered path, as a log does. */
function appendBuffered(streams: Streams, streamId: string, n: number) {
  const sync = streams.__DO_NOT_USE_WILL_BREAK__sync();
  for (let i = 0; i < n; i++) {
    const json = JSON.stringify({ i });
    sync.appendJson(streamId, json, json.length, BATCH);
  }
}

/** A closed stream, a live tagged one, and a buffered log trimmed. */
async function smoke(streams: Streams) {
  const writer = await streams.open("s1", { tag: "t", metadata: { a: 1 } });
  writer.append("one");
  writer.append("two");
  writer.close();
  const live = await streams.open("s2", { tag: "t" });
  live.append("live");
  const sync = streams.__DO_NOT_USE_WILL_BREAK__sync();
  sync.ensureTables();
  sync.insertStream("log", null, { epoch: "e" });
  appendBuffered(streams, "log", 40);
  sync.flush("log");
  sync.trim("log", { maxChunks: 8, maxBytes: 1_000_000 });
  (await streams.open("gone")).close();
  await streams.delete("gone");
}

describe("Streams instances", () => {
  describeInstanceConformance({
    kind: "streams",
    make: (name) => new Streams({ name }),
    smoke
  });

  it("keeps the default instance on the released table, index and key names", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const { lifecycle, capability } = install(new Streams());
      await lifecycle.start();
      await smoke(capability);
      const names = storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE name LIKE '%cf_agents_stream%' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`
        )
        .toArray()
        .map((row) => row.name);
      expect(names).toEqual([
        "cf_agents_stream_blocks",
        "cf_agents_streams",
        "idx_cf_agents_streams_tag"
      ]);
      expect(
        storage.kv.get<Record<string, number>>("cf_agents:schema_versions")
          ?.streams
      ).toBe(2);
    });
  });

  it("keeps the same stream id and tag apart in two instances", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const plain = new Streams();
      const audit = new Streams({ name: "audit" });
      const { lifecycle } = install(plain);
      lifecycle.use(audit);
      await lifecycle.start();

      const a = await plain.open("s1", { tag: "t" });
      a.append("default");
      a.close();
      const b = await audit.open("s1", { tag: "t" });
      b.append("audit-1");
      b.append("audit-2");

      expect(await collect(plain.read("s1"))).toEqual(["default"]);
      expect((await audit.status("s1"))?.state).toBe("streaming");
      expect((await audit.status("s1"))?.cursor).toBe(2);
      expect((await plain.status("s1"))?.state).toBe("completed");
      expect((await plain.list({ tag: "t" })).map((s) => s.cursor)).toEqual([
        1
      ]);
      expect((await audit.list({ tag: "t" })).map((s) => s.cursor)).toEqual([
        2
      ]);
      expect(
        audit.__DO_NOT_USE_WILL_BREAK__sync().rowsByTag("t", "streaming")
      ).toHaveLength(1);
      expect(
        plain.__DO_NOT_USE_WILL_BREAK__sync().rowsByTag("t", "streaming")
      ).toHaveLength(0);

      expect(await plain.delete("s1")).toBe(true);
      expect(await plain.status("s1")).toBeNull();
      expect((await audit.status("s1"))?.cursor).toBe(2);
      b.close();
      expect(await collect(audit.read("s1"))).toEqual(["audit-1", "audit-2"]);
    });
  });

  it("batches, leaves a hole after a lost buffer and trims the same on a named instance", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const plain = new Streams();
      const audit = new Streams({ name: "audit" });
      const { lifecycle } = install(plain);
      lifecycle.use(audit);
      await lifecycle.start();

      const run = (streams: Streams) => {
        const sync = streams.__DO_NOT_USE_WILL_BREAK__sync();
        sync.ensureTables();
        sync.insertStream("log", null, { epoch: "e" });
        appendBuffered(streams, "log", 6);
        sync.flush("log");
        appendBuffered(streams, "log", 30);
        sync.flush("log");
        sync.trim("log", { maxChunks: 8, maxBytes: 1_000_000 });
        return {
          bounds: sync.bounds("log"),
          rows: sync.readChunks("log", 0, 100).map((row) => row.seq)
        };
      };
      expect(run(audit)).toEqual(run(plain));
    });
  });

  it("drops a buffer whose write failed and leaves the same hole on a named instance", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const plain = new Streams();
      const audit = new Streams({ name: "audit" });
      const { lifecycle } = install(plain);
      lifecycle.use(audit);
      await lifecycle.start();

      const run = (streams: Streams, table: string) => {
        const sync = streams.__DO_NOT_USE_WILL_BREAK__sync();
        sync.insertStream("log", null, { epoch: "e" });
        appendBuffered(streams, "log", 3);
        sync.flush("log");
        appendBuffered(streams, "log", 2);
        storage.sql.exec(
          `CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table}
           BEGIN SELECT RAISE(ABORT, 'planted'); END`
        );
        expect(() => sync.flush("log")).toThrow(/planted/);
        storage.sql.exec(`DROP TRIGGER fail_${table}`);
        appendBuffered(streams, "log", 2);
        sync.flush("log");
        return {
          bounds: sync.bounds("log"),
          dropped: [3, 4, 5].map((seq) => sync.holds("log", seq)),
          rows: sync.readChunks("log", 0, 100).map((row) => row.seq)
        };
      };
      const named = run(audit, "cf_agents_stream_blocks__n_audit");
      expect(named.dropped).toEqual([false, false, false]);
      expect(named).toEqual(run(plain, "cf_agents_stream_blocks"));
    });
  });

  it("reads streams written by the released version as the default instance's", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      // The released schema (v2) and its rows, as the release wrote them:
      // a settled stream and a live one mid-turn.
      const sql = storage.sql;
      await storage.put("cf_agents:streams_schema_version", 2);
      sql.exec(`CREATE TABLE cf_agents_streams (
        stream_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('streaming', 'completed', 'errored')),
        tag TEXT, metadata TEXT, error_message TEXT,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER)`);
      sql.exec(`CREATE INDEX idx_cf_agents_streams_tag
        ON cf_agents_streams(tag, created_at)`);
      sql.exec(`CREATE TABLE cf_agents_stream_blocks (
        stream_id TEXT NOT NULL, block INTEGER NOT NULL,
        seq_from INTEGER NOT NULL, seq_to INTEGER NOT NULL, body TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (stream_id, block)) WITHOUT ROWID`);
      sql.exec(`INSERT INTO cf_agents_streams
        (stream_id, state, tag, chunk_count, created_at, updated_at, closed_at)
        VALUES ('done', 'completed', 'chat', 2, 1, 2, 2),
               ('live', 'streaming', 'chat', 0, 3, 3, NULL)`);
      sql.exec(`INSERT INTO cf_agents_stream_blocks VALUES
        ('done', 0, 0, 2, '{"type":"text","text":"a"},{"type":"text","text":"b"}', 1, 2),
        ('live', 0, 0, 1, '{"type":"text","text":"c"}', 3, 3)`);

      const plain = new Streams();
      const audit = new Streams({ name: "audit" });
      const { lifecycle } = install(plain);
      lifecycle.use(audit);
      await lifecycle.start();

      expect(await collect(plain.read("done"))).toEqual([
        { type: "text", text: "a" },
        { type: "text", text: "b" }
      ]);
      expect((await plain.status("live"))?.cursor).toBe(1);
      expect(await audit.status("done")).toBeNull();
      expect(await audit.list()).toEqual([]);
      // The live stream goes on where it was.
      const resumed = await plain.open("live");
      resumed.append({ type: "text", text: "d" });
      resumed.close();
      expect(await collect(plain.read("live"))).toHaveLength(2);
      expect(
        storage.kv.get<Record<string, number>>("cf_agents:schema_versions")?.[
          "streams/audit"
        ]
      ).toBe(2);
    });
  });

  it("leaves schema v1's chunk table to the default instance", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const sql = storage.sql;
      await storage.put("cf_agents:streams_schema_version", 1);
      sql.exec(`CREATE TABLE cf_agents_streams (
        stream_id TEXT PRIMARY KEY, state TEXT NOT NULL, tag TEXT, metadata TEXT,
        error_message TEXT, chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER)`);
      sql.exec(`CREATE TABLE cf_agents_stream_chunks (
        stream_id TEXT NOT NULL, seq INTEGER NOT NULL, chunk TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (stream_id, seq)) WITHOUT ROWID`);
      sql.exec(
        `INSERT INTO cf_agents_streams (stream_id, state, chunk_count, created_at, updated_at)
         VALUES ('old', 'streaming', 2, 1, 1)`
      );
      sql.exec(
        `INSERT INTO cf_agents_stream_chunks VALUES ('old', 0, '"x"', 1), ('old', 1, '"y"', 2)`
      );

      const plain = new Streams();
      const audit = new Streams({ name: "audit" });
      const { lifecycle } = install(audit);
      lifecycle.use(plain);
      await lifecycle.start();

      // The named instance has its own stream "old", and touching it folds
      // nothing of the default's.
      const own = await audit.open("old");
      own.append("mine");
      own.close();
      expect(
        sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM cf_agents_stream_chunks"
          )
          .one().n
      ).toBe(2);
      expect(await collect(audit.read("old"))).toEqual(["mine"]);

      const old = await plain.open("old");
      old.close();
      expect(await collect(plain.read("old"))).toEqual(["x", "y"]);
      expect(
        sql
          .exec(
            "SELECT name FROM sqlite_master WHERE name = 'cf_agents_stream_chunks'"
          )
          .toArray()
      ).toEqual([]);
    });
  });

  it("starts with no sqlite_master read, and probes for v1 chunks only on an object that had a schema", async () => {
    const queries = async (
      storage: DurableObjectStorage,
      fn: () => Promise<void>
    ): Promise<string[]> => {
      const sql = storage.sql;
      const exec = sql.exec.bind(sql);
      const seen: string[] = [];
      sql.exec = ((query: string, ...params: SqlStorageValue[]) => {
        seen.push(query);
        return exec(query, ...params);
      }) as typeof sql.exec;
      try {
        await fn();
      } finally {
        sql.exec = exec;
      }
      return seen;
    };
    await withCapabilityHarness(async ({ install, storage }) => {
      const { lifecycle } = install(new Streams());
      const fresh = await queries(storage, () => lifecycle.start());
      expect(
        fresh.filter((q) => /sqlite_master|stream_chunks/.test(q))
      ).toEqual([]);
    });
    await withCapabilityHarness(async ({ install, storage }) => {
      await storage.put("cf_agents:streams_schema_version", 2);
      const { lifecycle } = install(new Streams());
      const started = await queries(storage, () => lifecycle.start());
      expect(started.filter((q) => /sqlite_master/.test(q))).toEqual([]);
      expect(started.filter((q) => /stream_chunks/.test(q))).toEqual([
        "SELECT 1 FROM [cf_agents_stream_chunks] LIMIT 0"
      ]);
    });
  });

  it("folds a named instance's released version key into the record", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      storage.kv.put("cf_agents:streams/audit:streams_schema_version", 2);
      const plain = new Streams();
      const audit = new Streams({ name: "audit" });
      const { lifecycle } = install(plain);
      lifecycle.use(audit);
      await lifecycle.start();

      expect(
        storage.kv.get<Record<string, number>>("cf_agents:schema_versions")?.[
          "streams/audit"
        ]
      ).toBe(2);
      // A named instance never had v1 chunks: its key goes at once.
      expect(
        storage.kv.get("cf_agents:streams/audit:streams_schema_version")
      ).toBe(undefined);
    });
  });
});
