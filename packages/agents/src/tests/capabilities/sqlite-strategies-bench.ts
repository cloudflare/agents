import { DurableObject } from "cloudflare:workers";

/**
 * Experimental benchmark: three ways to hold a stream's temporary blocks in
 * DO SQLite before the atomic cutover to a session message.
 *
 *   temporary stream blocks → session message → delete temporary blocks
 *
 * S1 immutable packed rows — one INSERT per flush, DELETE all at cutover
 *    (today's Streams/ResumableStream shape).
 * S2 reusable generational slots — a pool of slot rows; a flush is an
 *    UPDATE of a free slot; cutover releases nothing (slots are free once
 *    the stream row is settled), so cleanup costs zero writes.
 * S3 mutable rollover blocks — one row per ~256 KB block; a flush is an
 *    UPDATE appending to the open block (rollover INSERTs a new one);
 *    cutover DELETEs the few block rows.
 *
 * Every strategy shares the stream row table and the message table and
 * performs the cutover inside one `transactionSync`. Measured per
 * workload: billed rows written (`cursor.rowsWritten`), rows read, wall
 * time for the write path, database size growth, cold replay time and
 * rows read, and the cursor recoverable from storage alone (what a
 * restarted isolate sees) at an arbitrary kill point.
 */

export type Strategy = "packed" | "slots" | "rollover";

export interface Workload {
  name: string;
  chunks: number;
  bytesPerChunk: number;
  /** Chunks per flush (the cadence a time-based flush would produce). */
  flushEvery: number;
}

export interface Measurement {
  strategy: Strategy;
  workload: string;
  rowsWritten: number;
  rowsRead: number;
  writeMs: number;
  cutoverRowsWritten: number;
  cutoverMs: number;
  dbGrowthBytes: number;
  dbPeakGrowthBytes: number;
  replayMs: number;
  replayRowsRead: number;
  replayChunks: number;
  /** Chunks recoverable from storage alone after a kill at `killAt`. */
  killAt: number;
  recoveredCursor: number;
}

const BLOCK_MAX_BYTES = 256 * 1024;
const SLOT_POOL = 64;

interface Counters {
  written: number;
  read: number;
}

export class SqliteStrategiesBench extends DurableObject<Cloudflare.Env> {
  #counters: Counters = { written: 0, read: 0 };
  #freeSlots: number[] = [];
  #poolSize = 0;
  readonly #ownedSlots = new Map<string, number[]>();

  #exec<
    T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>
  >(query: string, ...params: unknown[]) {
    const cursor = this.ctx.storage.sql.exec<T>(query, ...params);
    const rows = cursor.toArray();
    this.#counters.written += cursor.rowsWritten;
    this.#counters.read += cursor.rowsRead;
    return rows;
  }

  #reset(): Counters {
    const c = { ...this.#counters };
    this.#counters = { written: 0, read: 0 };
    return c;
  }

  #schema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS b_streams (
      stream_id TEXT PRIMARY KEY, state TEXT NOT NULL, chunk_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS b_messages (
      session_id TEXT NOT NULL, id TEXT NOT NULL, content TEXT NOT NULL,
      PRIMARY KEY (session_id, id)) WITHOUT ROWID`);
    // S1
    sql.exec(`CREATE TABLE IF NOT EXISTS s1_chunks (
      stream_id TEXT NOT NULL, seq INTEGER NOT NULL, chunk TEXT NOT NULL,
      PRIMARY KEY (stream_id, seq)) WITHOUT ROWID`);
    // S2: a pool of slots. stream_id/gen say who owns a slot; a slot is
    // free when its owner's stream row is not `streaming`.
    sql.exec(`CREATE TABLE IF NOT EXISTS s2_slots (
      slot INTEGER PRIMARY KEY, stream_id TEXT, gen INTEGER NOT NULL DEFAULT 0,
      seq_from INTEGER NOT NULL DEFAULT 0, seq_to INTEGER NOT NULL DEFAULT 0,
      chunk TEXT NOT NULL DEFAULT '') WITHOUT ROWID`);
    // S3
    sql.exec(`CREATE TABLE IF NOT EXISTS s3_blocks (
      stream_id TEXT NOT NULL, block INTEGER NOT NULL, seq_from INTEGER NOT NULL,
      seq_to INTEGER NOT NULL, chunk TEXT NOT NULL,
      PRIMARY KEY (stream_id, block)) WITHOUT ROWID`);
  }

  #body(i: number, bytes: number): string {
    return JSON.stringify({
      type: "text-delta",
      delta: `${i}:${"x".repeat(Math.max(0, bytes - 40))}`
    });
  }

  // ── Strategy write paths ──────────────────────────────────────────────

  /** One packed flush. Returns nothing; the row accounting is global. */
  #flush(
    strategy: Strategy,
    streamId: string,
    gen: number,
    seqFrom: number,
    seqTo: number,
    packed: string,
    st: { block: number; blockBytes: number; slots: number[] }
  ): void {
    switch (strategy) {
      case "packed":
        this.#exec(
          "INSERT INTO s1_chunks (stream_id, seq, chunk) VALUES (?, ?, ?)",
          streamId,
          seqFrom,
          packed
        );
        return;
      case "slots": {
        // Free list lives in memory (rebuilt by one pool scan on a cold
        // start); popping costs no read, releasing at cutover no write.
        let slot = this.#freeSlots.pop();
        if (slot === undefined) {
          // Every slot is owned by a live stream: grow the pool (one INSERT).
          slot = this.#poolSize++;
          this.#exec(
            "INSERT INTO s2_slots (slot, stream_id, gen, seq_from, seq_to, chunk) VALUES (?, ?, ?, ?, ?, ?)",
            slot,
            streamId,
            gen,
            seqFrom,
            seqTo,
            packed
          );
        } else {
          this.#exec(
            "UPDATE s2_slots SET stream_id = ?, gen = ?, seq_from = ?, seq_to = ?, chunk = ? WHERE slot = ?",
            streamId,
            gen,
            seqFrom,
            seqTo,
            packed,
            slot
          );
        }
        st.slots.push(slot);
        const owned = this.#ownedSlots.get(streamId) ?? [];
        owned.push(slot);
        this.#ownedSlots.set(streamId, owned);
        return;
      }
      case "rollover": {
        if (
          st.blockBytes > 0 &&
          st.blockBytes + packed.length <= BLOCK_MAX_BYTES
        ) {
          this.#exec(
            "UPDATE s3_blocks SET chunk = chunk || ?, seq_to = ? WHERE stream_id = ? AND block = ?",
            `,${packed}`,
            seqTo,
            streamId,
            st.block
          );
          st.blockBytes += packed.length + 1;
        } else {
          st.block += 1;
          this.#exec(
            "INSERT INTO s3_blocks (stream_id, block, seq_from, seq_to, chunk) VALUES (?, ?, ?, ?, ?)",
            streamId,
            st.block,
            seqFrom,
            seqTo,
            packed
          );
          st.blockBytes = packed.length;
        }
        return;
      }
    }
  }

  /** Every chunk recoverable from storage alone, in order. */
  #replay(strategy: Strategy, streamId: string, gen: number): string[] {
    const unpack = (rows: { chunk: string }[]) =>
      rows.flatMap((r) => JSON.parse(`[${r.chunk}]`) as string[]);
    switch (strategy) {
      case "packed":
        return unpack(
          this.#exec<{ chunk: string }>(
            "SELECT chunk FROM s1_chunks WHERE stream_id = ? ORDER BY seq",
            streamId
          )
        );
      case "slots":
        return unpack(
          this.#exec<{ chunk: string }>(
            "SELECT chunk FROM s2_slots WHERE stream_id = ? AND gen = ? ORDER BY seq_from",
            streamId,
            gen
          )
        );
      case "rollover":
        return unpack(
          this.#exec<{ chunk: string }>(
            "SELECT chunk FROM s3_blocks WHERE stream_id = ? ORDER BY block",
            streamId
          )
        );
    }
  }

  #cleanup(strategy: Strategy, streamId: string): void {
    switch (strategy) {
      case "packed":
        this.#exec("DELETE FROM s1_chunks WHERE stream_id = ?", streamId);
        return;
      case "slots": {
        // Release in memory only; the settled stream row is the proof.
        const owned = this.#ownedSlots.get(streamId) ?? [];
        this.#freeSlots.push(...owned);
        this.#ownedSlots.delete(streamId);
        return;
      }
      case "rollover":
        this.#exec("DELETE FROM s3_blocks WHERE stream_id = ?", streamId);
        return;
    }
  }

  // ── Bench ─────────────────────────────────────────────────────────────

  /**
   * Run one workload under one strategy: open, flush every `flushEvery`
   * chunks, measure the storage-only recoverable cursor at `killAt`
   * (before cutover), cutover atomically, then cold-replay the message.
   */
  async run(
    strategy: Strategy,
    workload: Workload,
    killAt: number
  ): Promise<Measurement> {
    this.#schema();
    const streamId = `${strategy}-${workload.name}-${crypto.randomUUID().slice(0, 8)}`;
    const gen = Date.now() % 1_000_000;
    const now = Date.now();
    const sizeBefore = this.ctx.storage.sql.databaseSize;
    let peak = sizeBefore;
    this.#reset();
    const t0 = performance.now();
    this.#exec(
      "INSERT INTO b_streams (stream_id, state, chunk_count, created_at, updated_at) VALUES (?, 'streaming', 0, ?, ?)",
      streamId,
      now,
      now
    );
    const st = { block: 0, blockBytes: 0, slots: [] as number[] };
    let buffer: string[] = [];
    let seqFrom = 0;
    let recoveredCursor = -1;
    const flushNow = (seqTo: number) => {
      if (buffer.length === 0) return;
      this.#flush(
        strategy,
        streamId,
        gen,
        seqFrom,
        seqTo,
        buffer.map((b) => JSON.stringify(b)).join(","),
        st
      );
      seqFrom = seqTo;
      buffer = [];
      peak = Math.max(peak, this.ctx.storage.sql.databaseSize);
    };
    for (let i = 0; i < workload.chunks; i++) {
      buffer.push(this.#body(i, workload.bytesPerChunk));
      if (buffer.length >= workload.flushEvery) flushNow(i + 1);
      if (i + 1 === killAt) {
        // What storage alone holds right now = what a restart recovers.
        const c = this.#reset();
        recoveredCursor = this.#replay(strategy, streamId, gen).length;
        this.#reset();
        this.#counters = c;
      }
    }
    // Final flush of the tail is part of the cutover block below.
    const writeMs = performance.now() - t0;
    const written = this.#reset();

    // Atomic cutover: final tail flush, message insert, settle, cleanup.
    const t1 = performance.now();
    this.ctx.storage.transactionSync(() => {
      flushNow(workload.chunks);
      const all = this.#replay(strategy, streamId, gen);
      this.#exec(
        "INSERT INTO b_messages (session_id, id, content) VALUES (?, ?, ?)",
        "session",
        streamId,
        JSON.stringify(all)
      );
      this.#exec(
        "UPDATE b_streams SET state = 'completed', chunk_count = ?, updated_at = ? WHERE stream_id = ?",
        all.length,
        Date.now(),
        streamId
      );
      this.#cleanup(strategy, streamId);
    });
    const cutoverMs = performance.now() - t1;
    const cutover = this.#reset();
    peak = Math.max(peak, this.ctx.storage.sql.databaseSize);
    const sizeAfter = this.ctx.storage.sql.databaseSize;

    // Cold replay of the handed-off message.
    const t2 = performance.now();
    const replayed = JSON.parse(
      this.#exec<{ content: string }>(
        "SELECT content FROM b_messages WHERE session_id = ? AND id = ?",
        "session",
        streamId
      )[0].content
    ) as string[];
    const replayMs = performance.now() - t2;
    const replay = this.#reset();

    return {
      strategy,
      workload: workload.name,
      rowsWritten: written.written,
      rowsRead: written.read,
      writeMs: Math.round(writeMs * 100) / 100,
      cutoverRowsWritten: cutover.written,
      cutoverMs: Math.round(cutoverMs * 100) / 100,
      dbGrowthBytes: sizeAfter - sizeBefore,
      dbPeakGrowthBytes: peak - sizeBefore,
      replayMs: Math.round(replayMs * 100) / 100,
      replayRowsRead: replay.read,
      replayChunks: replayed.length,
      killAt,
      recoveredCursor
    };
  }

  /**
   * Real-kill half: flush up to `killAt` chunks (mid-flush leftovers stay
   * in memory), then abort the object. Nothing after `ctx.abort()` runs.
   */
  #ensurePool(): void {
    if (this.#poolSize > 0) return;
    const rows = this.ctx.storage.sql
      .exec<{ slot: number; stream_id: string | null }>(
        "SELECT slot, stream_id FROM s2_slots ORDER BY slot"
      )
      .toArray();
    this.#poolSize = rows.length;
    this.#freeSlots = rows
      .filter((r) => r.stream_id === null)
      .map((r) => r.slot)
      .reverse();
  }

  async writeThenAbort(
    strategy: Strategy,
    workload: Workload,
    killAt: number,
    streamId: string,
    gen: number,
    gapMs = 0
  ): Promise<never> {
    this.#schema();
    this.#ensurePool();
    const now = Date.now();
    this.#exec(
      "INSERT INTO b_streams (stream_id, state, chunk_count, created_at, updated_at) VALUES (?, 'streaming', 0, ?, ?)",
      streamId,
      now,
      now
    );
    const st = { block: 0, blockBytes: 0, slots: [] as number[] };
    let buffer: string[] = [];
    let seqFrom = 0;
    for (let i = 0; i < killAt; i++) {
      buffer.push(this.#body(i, workload.bytesPerChunk));
      if (buffer.length >= workload.flushEvery) {
        this.#flush(
          strategy,
          streamId,
          gen,
          seqFrom,
          i + 1,
          buffer.map((b) => JSON.stringify(b)).join(","),
          st
        );
        seqFrom = i + 1;
        buffer = [];
        // A real producer awaits between chunks; each await ends the
        // synchronous block and lets its writes commit.
        if (gapMs >= 0) await new Promise((r) => setTimeout(r, gapMs));
      }
    }
    this.ctx.abort("simulated crash");
    throw new Error("unreachable");
  }

  /** What a fresh isolate can recover from storage alone. */
  async recover(
    strategy: Strategy,
    streamId: string,
    gen: number
  ): Promise<number> {
    this.#schema();
    return this.#replay(strategy, streamId, gen).length;
  }

  /** Reset every table so strategies do not pay for each other's pages. */
  async wipe(): Promise<void> {
    this.#schema();
    for (const t of [
      "b_streams",
      "b_messages",
      "s1_chunks",
      "s2_slots",
      "s3_blocks"
    ]) {
      this.ctx.storage.sql.exec(`DELETE FROM ${t}`);
    }
    // Pre-create the slot pool so S2 does not pay INSERTs on its first stream.
    for (let i = 0; i < SLOT_POOL; i++) {
      this.ctx.storage.sql.exec("INSERT INTO s2_slots (slot) VALUES (?)", i);
    }
    this.#poolSize = SLOT_POOL;
    this.#freeSlots = Array.from(
      { length: SLOT_POOL },
      (_, i) => SLOT_POOL - 1 - i
    );
    this.#ownedSlots.clear();
  }
}
