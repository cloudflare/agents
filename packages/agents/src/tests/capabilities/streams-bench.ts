import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import { ResumableStream, createChatStreams } from "../../chat";

/**
 * Storage-ops benchmark harness for the chat-on-Streams replatform: measures
 * SQLite rows written (via `total_changes()`) and wall time for one simulated
 * chat-turn workload under three write paths, plus the read amplification of
 * the two retention-sweep shapes. Counts are deterministic — the assertions
 * pin the storage-op *model*, and the logged numbers feed the PR accounting.
 */
export class StreamBenchObject extends DurableObject<Cloudflare.Env> {
  readonly streams = createChatStreams();
  readonly lifecycle = Lifecycle.install(this).use(this.streams);

  #totalChanges(): number {
    const cursor = this.ctx.storage.sql.exec(
      "SELECT total_changes() AS changes"
    );
    return Number([...cursor][0].changes);
  }

  #body(index: number, chunkBytes: number): string {
    const filler = "x".repeat(Math.max(0, chunkBytes - 40));
    return JSON.stringify({ type: "text-delta", delta: `${index}:${filler}` });
  }

  /**
   * The replatformed path: real `ResumableStream` over the real Streams
   * capability — packed segments through the read-fenced append (one chunk
   * INSERT per segment; the stream row is written only at open and settle).
   */
  async benchAdapterPath(
    turns: number,
    chunksPerTurn: number,
    chunkBytes: number
  ): Promise<{ rowsWritten: number; ms: number }> {
    await this.lifecycle.start();
    const adapter = new ResumableStream(
      this.streams,
      <T = Record<string, unknown>>(
        strings: TemplateStringsArray,
        ...values: (string | number | boolean | null)[]
      ): T[] =>
        [
          ...this.ctx.storage.sql.exec(
            strings.reduce(
              (q, part, i) => q + part + (i < values.length ? "?" : ""),
              ""
            ),
            ...values
          )
        ] as T[]
    );
    const before = this.#totalChanges();
    const start = performance.now();
    for (let turn = 0; turn < turns; turn++) {
      const streamId = adapter.start(`bench-req-${turn}`);
      for (let i = 0; i < chunksPerTurn; i++) {
        adapter.storeChunk(streamId, this.#body(i, chunkBytes));
      }
      adapter.complete(streamId);
    }
    const ms = performance.now() - start;
    return { rowsWritten: this.#totalChanges() - before, ms };
  }

  /**
   * The pre-replatform write pattern, simulated exactly: own metadata +
   * chunk tables, 10-chunk packed segment rows, one metadata INSERT and one
   * completion UPDATE per turn. (The old in-memory buffer's flush cadence,
   * without its durability hole being exercised.)
   */
  async benchLegacySimulation(
    turns: number,
    chunksPerTurn: number,
    chunkBytes: number
  ): Promise<{ rowsWritten: number; ms: number }> {
    await this.lifecycle.start();
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS bench_legacy_metadata (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, completed_at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS bench_legacy_chunks (
      id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, body TEXT NOT NULL,
      chunk_index INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    // The index the legacy ResumableStream shipped, so sweep reads are
    // measured against the real pre-replatform access path.
    sql.exec(`CREATE INDEX IF NOT EXISTS bench_legacy_chunks_stream_id
      ON bench_legacy_chunks(stream_id, chunk_index)`);
    const before = this.#totalChanges();
    const start = performance.now();
    for (let turn = 0; turn < turns; turn++) {
      const streamId = `legacy-${turn}`;
      sql.exec(
        `INSERT INTO bench_legacy_metadata (id, request_id, status, created_at)
         VALUES (?, ?, 'streaming', ?)`,
        streamId,
        `bench-req-${turn}`,
        Date.now()
      );
      let buffer: string[] = [];
      let segmentIndex = 0;
      const flush = () => {
        if (buffer.length === 0) return;
        const body = buffer.length === 1 ? buffer[0] : JSON.stringify(buffer);
        sql.exec(
          `INSERT INTO bench_legacy_chunks (id, stream_id, body, chunk_index, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          `${streamId}-${segmentIndex}`,
          streamId,
          body,
          segmentIndex,
          Date.now()
        );
        segmentIndex++;
        buffer = [];
      };
      for (let i = 0; i < chunksPerTurn; i++) {
        buffer.push(this.#body(i, chunkBytes));
        if (buffer.length >= 10) flush();
      }
      flush();
      sql.exec(
        `UPDATE bench_legacy_metadata SET status = 'completed', completed_at = ?
         WHERE id = ?`,
        Date.now(),
        streamId
      );
    }
    const ms = performance.now() - start;
    return { rowsWritten: this.#totalChanges() - before, ms };
  }

  /** The naive contrast: one Streams append (chunk INSERT) per chunk. */
  async benchPerChunkPath(
    turns: number,
    chunksPerTurn: number,
    chunkBytes: number
  ): Promise<{ rowsWritten: number; ms: number }> {
    await this.lifecycle.start();
    const before = this.#totalChanges();
    const start = performance.now();
    for (let turn = 0; turn < turns; turn++) {
      const writer = await this.streams.open(`perchunk-${turn}`);
      for (let i = 0; i < chunksPerTurn; i++) {
        writer.append(this.#body(i, chunkBytes));
      }
      writer.close();
    }
    const ms = performance.now() - start;
    return { rowsWritten: this.#totalChanges() - before, ms };
  }

  /**
   * The billed-write accounting model, measured: `rowsWritten` per INSERT
   * and UPDATE against rowid vs WITHOUT ROWID tables and explicit indexes.
   * `total_changes()` counts only table rows; Cloudflare bills index
   * maintenance too, and `rowsWritten` is the billed metric — an ordinary
   * rowid table's PRIMARY KEY is a hidden UNIQUE index that bills one
   * extra row on every INSERT and DELETE, which is why the capability
   * tables are WITHOUT ROWID. The `real*` entries pin the billed cost of
   * the actual hot statements against the real schema.
   */
  async probeWriteAccounting(): Promise<Record<string, number>> {
    await this.lifecycle.start();
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS bench_probe_rowid (
      a TEXT NOT NULL, b INTEGER NOT NULL, body TEXT, PRIMARY KEY (a, b))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS bench_probe_worowid (
      a TEXT NOT NULL, b INTEGER NOT NULL, body TEXT, PRIMARY KEY (a, b)
      ) WITHOUT ROWID`);
    sql.exec(`CREATE TABLE IF NOT EXISTS bench_probe_indexed (
      id TEXT PRIMARY KEY, tag TEXT, other TEXT)`);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS bench_probe_tag ON bench_probe_indexed(tag)`
    );
    const w = (query: string, ...params: (string | number)[]) =>
      Number(sql.exec(query, ...params).rowsWritten);
    const now = Date.now();
    return {
      rowidCompositePkInsert: w(
        `INSERT INTO bench_probe_rowid (a, b, body) VALUES ('x', 1, 'body')`
      ),
      withoutRowidInsert: w(
        `INSERT INTO bench_probe_worowid (a, b, body) VALUES ('x', 1, 'body')`
      ),
      textPkPlusIndexInsert: w(
        `INSERT INTO bench_probe_indexed (id, tag, other) VALUES ('i1', 't', 'o')`
      ),
      updateNotTouchingIndexed: w(
        `UPDATE bench_probe_indexed SET other = 'o2' WHERE id = 'i1'`
      ),
      updateTouchingIndexed: w(
        `UPDATE bench_probe_indexed SET tag = 't2' WHERE id = 'i1'`
      ),
      realStreamOpen: w(
        `INSERT INTO cf_agents_streams
           (stream_id, state, tag, metadata, chunk_count, created_at, updated_at)
         VALUES ('probe-s', 'streaming', 'probe-tag', NULL, 0, ?, ?)`,
        now,
        now
      ),
      realChunkAppend: w(
        `INSERT INTO cf_agents_stream_chunks (stream_id, seq, chunk, created_at)
         VALUES ('probe-s', 0, '"x"', ?)`,
        now
      ),
      realStreamSettle: w(
        `UPDATE cf_agents_streams
         SET state = 'completed', error_message = NULL, closed_at = ?,
             updated_at = ?, chunk_count = 1
         WHERE stream_id = 'probe-s' AND state = 'streaming'`,
        now,
        now
      )
    };
  }

  /**
   * Sweep read amplification: rows read to decide abandonment for the
   * streams seeded by the paths above (bench_legacy_* vs cf_agents_streams).
   *
   * Legacy shape: correlated `max(created_at)` subquery over the chunk table
   * for every stream. New shape: the two-phase decision the real sweep runs —
   * one scan of the stream rows (whose `updated_at` is stamped at open and
   * settle, not per append), then one indexed chunk-tail read for each live
   * row past the coarse cutoff. A live in-flight stream is seeded so the
   * phase-2 verification read is part of the measurement.
   */
  async benchSweepReads(): Promise<{
    legacyRowsRead: number;
    newRowsRead: number;
  }> {
    await this.lifecycle.start();
    const sql = this.ctx.storage.sql;
    const cutoff = Date.now() + 60_000; // classify every seeded stream
    const writer = await this.streams.open("sweep-live");
    writer.append(this.#body(0, 120));
    const legacyCursor = sql.exec(
      `SELECT m.id FROM bench_legacy_metadata m
       WHERE coalesce(
         (SELECT max(c.created_at) FROM bench_legacy_chunks c
          WHERE c.stream_id = m.id),
         m.created_at
       ) < ?`,
      cutoff
    );
    [...legacyCursor];
    const rowsCursor = sql.exec(`SELECT * FROM cf_agents_streams`);
    const rows = [...rowsCursor] as Array<{
      stream_id: string;
      state: string;
      updated_at: number;
    }>;
    let newRowsRead = Number(rowsCursor.rowsRead);
    for (const row of rows) {
      if (row.state !== "streaming" || Number(row.updated_at) >= cutoff) {
        continue;
      }
      const tail = sql.exec(
        `SELECT seq, created_at FROM cf_agents_stream_chunks
         WHERE stream_id = ? ORDER BY seq DESC LIMIT 1`,
        row.stream_id
      );
      [...tail];
      newRowsRead += Number(tail.rowsRead);
    }
    return {
      legacyRowsRead: Number(legacyCursor.rowsRead),
      newRowsRead
    };
  }
}
