/**
 * Durable incremental output for Lifecycle Objects. `Streams` owns the
 * `cf_agents_streams` and `cf_agents_stream_chunks` tables: an ordered,
 * durable chunk log per stream with a monotonic cursor, replay-then-tail
 * reads, and terminal status that doubles as recovery evidence for the
 * Tasks capability (which composes through checkpointed cursors, never
 * imports).
 *
 * Streams consumes only the standard capability services — storage and
 * events. It needs no alarm, so it also works on facets. Live fanout is
 * in-isolate: a Durable Object executes in one isolate at a time, so every
 * concurrent reader shares the producer's isolate; readers that outlive an
 * isolate replay from their cursor on reconnect.
 */

import { LifecycleCapability } from "../lifecycle/capability";
import { SqlError } from "../sql-error";
import {
  StreamClosedError,
  StreamNotFoundError,
  StreamSerializationError
} from "./errors";
import type {
  StreamChunk,
  StreamChunkRow,
  StreamJson,
  StreamListOptions,
  StreamOpenOptions,
  StreamReadBatchesOptions,
  StreamReadOptions,
  StreamRow,
  StreamState,
  StreamStatus,
  StreamWriter
} from "./types";

const STREAM_SCHEMA_VERSION_KEY = "cf_agents:streams_schema_version";
const CURRENT_STREAM_SCHEMA_VERSION = 1;

/** Default ceiling for one serialized chunk (1 MiB). */
export const DEFAULT_MAX_CHUNK_BYTES = 1_048_576;

const MAX_STREAM_ID_LENGTH = 256;
const READ_BATCH_SIZE = 100;
const DEFAULT_LIST_LIMIT = 100;

const utf8 = new TextEncoder();

/**
 * Policy for a Streams capability.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface StreamsOptions {
  /** Ceiling for one serialized chunk. Default: 1 MiB. */
  readonly maxChunkBytes?: number;
}

/**
 * @internal Synchronous operations returned by
 * {@link Streams.__DO_NOT_USE_WILL_BREAK__sync}. For same-isolate first-party
 * machinery only (the chat `ResumableStream` adapter); every method bypasses
 * `lifecycle.ready()`, so the caller owns startup ordering.
 */
export interface StreamsSyncInternal {
  /** Idempotent DDL — safe to call before the Lifecycle starts. */
  ensureTables(): void;
  getStream(streamId: string): StreamRow | undefined;
  /** Insert a live stream row (no idempotency — caller checks first). */
  insertStream(
    streamId: string,
    tag: string | null,
    metadata: Record<string, StreamJson> | undefined
  ): void;
  /** The read-fenced append: one chunk insert at the log tail, reader wakeup. */
  append(streamId: string, chunk: StreamJson): number;
  /**
   * The newest chunk's timestamp, or null for an empty log. One PK-served
   * read — the per-append liveness signal retention sweeps verify against
   * (a live row's `updated_at` is set at open and not bumped by appends).
   */
  lastChunkAt(streamId: string): number | null;
  /** Idempotent settlement with events and reader wakeup. */
  settle(
    streamId: string,
    state: "completed" | "errored",
    reason: string | null
  ): void;
  /** Delete a stream and its chunks regardless of state. */
  deleteUnchecked(streamId: string): void;
  /** Delete many streams and their chunks regardless of state, silently. */
  deleteMany(streamIds: string[]): void;
  /**
   * One page of a stream's chunk log from `fromSeq` (inclusive), ordered by
   * seq. Paged rather than read-it-all so replaying a large stream holds
   * one page of segment bodies in memory, not the whole turn.
   */
  readChunks(
    streamId: string,
    fromSeq: number,
    limit: number
  ): StreamChunkRow[];
  /** Every stream row, newest first (created_at, then insertion order). */
  listRows(): StreamRow[];
  /**
   * Every row carrying a tag, newest first, optionally narrowed to one
   * state. Tags are non-unique and the table is shared across producers,
   * so callers apply their own ownership filter (e.g. chat's metadata
   * marker) rather than trusting the newest row.
   */
  rowsByTag(tag: string, state?: StreamState): StreamRow[];
  /**
   * Import one historical stream row verbatim (migrations, test seeding):
   * explicit timestamps and count, no events, no wakeups.
   */
  importStream(row: {
    streamId: string;
    state: StreamState;
    tag: string | null;
    metadata: Record<string, StreamJson> | undefined;
    chunkCount: number;
    createdAt: number;
    updatedAt: number;
    closedAt: number | null;
  }): void;
  /**
   * Import one historical chunk at the log's tail: one INSERT, nothing else.
   * The stream row is not touched — importers pass the final `chunkCount`
   * and `updatedAt` to {@link importStream}, so the row is exact at rest
   * without a per-chunk row write.
   */
  importChunk(streamId: string, chunk: StreamJson, createdAt: number): void;
}

/**
 * Durable incremental output for a Lifecycle Object.
 *
 * `open()` a stream, `append()` chunks (synchronous durable writes that wake
 * live readers), and settle it with `close()` or `error()`. `read()` replays
 * persisted chunks from a cursor and then tails live appends; `status()`
 * reports the state and cursor — the recovery evidence a Task's `recover`
 * callback consults after its producer was interrupted.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Streams extends LifecycleCapability {
  readonly #maxChunkBytes: number;
  /** Wakeup callbacks for readers tailing a live stream, per stream. */
  readonly #wakeups = new Map<string, Set<() => void>>();

  constructor(options: StreamsOptions = {}) {
    super("streams");
    this.#maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  }

  // ── Lifecycle capability hooks ───────────────────────────────────────────

  /** Migrate stream storage during Lifecycle startup. */
  async onStart(): Promise<void> {
    const storage = this.lifecycle.storage;
    const version = (await storage.get<number>(STREAM_SCHEMA_VERSION_KEY)) ?? 0;
    if (version < CURRENT_STREAM_SCHEMA_VERSION) {
      this.#ensureTables();
      await storage.put(
        STREAM_SCHEMA_VERSION_KEY,
        CURRENT_STREAM_SCHEMA_VERSION
      );
    }
  }

  // ── Producer surface ─────────────────────────────────────────────────────

  /**
   * Open a stream for writing. Idempotent on the id: reopening a live stream
   * returns a writer positioned at its current cursor; reopening a terminal
   * stream throws {@link StreamClosedError}.
   */
  async open(
    streamId: string,
    options: StreamOpenOptions = {}
  ): Promise<StreamWriter> {
    await this.lifecycle.ready();
    this.#validateStreamId(streamId);

    const existing = this.#getStream(streamId);
    if (existing) {
      if (existing.state !== "streaming") {
        throw new StreamClosedError(
          streamId,
          `already settled as ${existing.state}`
        );
      }
      // The tag is part of the stream's identity, fixed at creation: a
      // reopen naming a different tag is a config conflict, not a resume.
      if (
        options.tag !== undefined &&
        options.tag !== (existing.tag ?? undefined)
      ) {
        throw new Error(
          `Stream "${streamId}" is already open with tag ${JSON.stringify(existing.tag)}; refusing reopen with tag ${JSON.stringify(options.tag)}`
        );
      }
      return this.#writer(streamId);
    }

    const metadataJson = this.#serialize(
      options.metadata,
      `metadata for stream "${streamId}"`
    );
    const now = Date.now();
    this.#sql`
      INSERT INTO cf_agents_streams
        (stream_id, state, tag, metadata, chunk_count, created_at, updated_at)
      VALUES
        (${streamId}, 'streaming', ${options.tag ?? null}, ${metadataJson}, 0, ${now}, ${now})
    `;
    this.#emit("stream:opened", { streamId });
    return this.#writer(streamId);
  }

  // ── Consumer surface ─────────────────────────────────────────────────────

  /**
   * Replay persisted chunks from `from` (inclusive), then tail live appends
   * until the stream settles. Ends when the stream reaches a terminal state
   * and every durable chunk has been yielded; a read of an `errored` stream
   * still yields its chunks and then simply ends — consult {@link status}
   * for the terminal outcome. Aborting `options.signal` throws its reason.
   */
  async *read(
    streamId: string,
    options: StreamReadOptions = {}
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const signal = options.signal;
    for await (const batch of this.readBatches(streamId, options)) {
      for (const item of batch) {
        if (signal?.aborted) throw signal.reason ?? new Error("Read aborted");
        yield item;
      }
    }
  }

  /**
   * Batched form of {@link read}: yields non-empty arrays of consecutive
   * chunks instead of one chunk at a time. Replay yields up to
   * `options.batchSize` chunks per array; a live tail yields everything
   * that accumulated since the last wakeup as one array — so a consumer
   * paying per write (an SSE flush, an RPC hop, a history append) pays
   * once per backlog, not once per chunk. Same lifecycle as {@link read}:
   * ends when the stream settles and every durable chunk has been
   * yielded; aborting `options.signal` throws its reason.
   */
  async *readBatches(
    streamId: string,
    options: StreamReadBatchesOptions = {}
  ): AsyncGenerator<StreamChunk[], void, undefined> {
    await this.lifecycle.ready();
    const signal = options.signal;
    const batchSize = Math.max(
      1,
      Math.floor(options.batchSize ?? READ_BATCH_SIZE)
    );
    let next = Math.max(0, options.from ?? 0);
    let signaledUpToDate = false;

    if (this.#state(streamId) === undefined) {
      throw new StreamNotFoundError(streamId);
    }

    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("Read aborted");

      const rows = this.#sql<StreamChunkRow>`
        SELECT stream_id, seq, chunk, created_at FROM cf_agents_stream_chunks
        WHERE stream_id = ${streamId} AND seq >= ${next}
        ORDER BY seq ASC
        LIMIT ${batchSize}
      `;
      if (rows.length > 0) {
        next = rows[rows.length - 1].seq + 1;
        yield rows.map((row) => ({
          seq: row.seq,
          chunk: JSON.parse(row.chunk) as StreamJson
        }));
      }
      if (rows.length === batchSize) continue;

      // A short batch means every durable chunk up to this instant has been
      // yielded — the reader has reached the tail (caught up ≠ ended: a live
      // stream keeps tailing from here).
      if (!signaledUpToDate) {
        signaledUpToDate = true;
        options.onUpToDate?.();
        // The callback is application code and can synchronously append to
        // this same stream — a wake that would fire before any waiter is
        // registered. Re-poll instead of sleeping so that append is never a
        // lost wakeup; everything from the next query to waiter
        // registration is synchronous, so no other append can slip past.
        continue;
      }

      const state = this.#state(streamId);
      if (state === undefined) return; // deleted mid-read: nothing further
      if (state !== "streaming") {
        // Terminal. Appends happen-before settlement (the append fence
        // rejects a settled stream), so a poll that returned zero rows in
        // this same synchronous block proves every durable chunk has been
        // yielded; a non-empty short batch yielded (a suspension point),
        // so re-poll to drain the remainder first.
        if (rows.length === 0) return;
        continue;
      }

      // Live tail: wait for the next append or settlement, then re-poll.
      // Wakeups carry no data, so there is nothing to buffer or dedupe.
      await this.#waitForWakeup(streamId, signal);
    }
  }

  /** Read one stream's state and cursor, or null when it does not exist. */
  async status(streamId: string): Promise<StreamStatus | null> {
    await this.lifecycle.ready();
    const row = this.#getStream(streamId);
    return row ? this.#rowToStatus(row) : null;
  }

  /** List streams, newest first. */
  async list(options: StreamListOptions = {}): Promise<StreamStatus[]> {
    await this.lifecycle.ready();
    const states = Array.isArray(options.state)
      ? options.state
      : options.state !== undefined
        ? [options.state]
        : [];
    let query = "SELECT * FROM cf_agents_streams WHERE 1 = 1";
    const params: (string | number)[] = [];
    if (states.length > 0) {
      query += ` AND state IN (${states.map(() => "?").join(", ")})`;
      params.push(...states);
    }
    if (options.tag !== undefined) {
      query += " AND tag = ?";
      params.push(options.tag);
    }
    query += " ORDER BY created_at DESC, stream_id DESC LIMIT ?";
    params.push(options.limit ?? DEFAULT_LIST_LIMIT);
    let rows: unknown[];
    try {
      rows = this.lifecycle.storage.sql.exec(query, ...params).toArray();
    } catch (cause) {
      throw new SqlError(query, cause);
    }
    // SAFETY: the query selects * from Streams' own schema.
    return (rows as StreamRow[]).map((row) => this.#rowToStatus(row));
  }

  /**
   * Delete one terminal stream and its chunk log.
   *
   * @returns True when a terminal stream was deleted; false when none
   * exists. Throws on a live stream — settle it first.
   */
  async delete(streamId: string): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#getStream(streamId);
    if (!row) return false;
    if (row.state === "streaming") {
      throw new Error(
        `Cannot delete live stream "${streamId}"; close() or error() it first`
      );
    }
    this.#sql`
      DELETE FROM cf_agents_stream_chunks WHERE stream_id = ${streamId}
    `;
    this.#sql`DELETE FROM cf_agents_streams WHERE stream_id = ${streamId}`;
    this.#emit("stream:deleted", { streamId });
    return true;
  }

  // ── Internal sync aperture ───────────────────────────────────────────────

  /**
   * @internal Synchronous storage operations for same-isolate first-party
   * machinery — today the chat `ResumableStream` adapter, whose whole public
   * surface is synchronous and constructed before the Lifecycle starts.
   * Bypasses `lifecycle.ready()`: the caller owns startup ordering. The
   * invariant-bearing writes (append fence, settlement, wakeups, events) go
   * through the same private methods as the public API, so live readers and
   * diagnostics observe aperture writes exactly like capability writes. Will
   * break without notice; never use from application code.
   */
  __DO_NOT_USE_WILL_BREAK__sync(): StreamsSyncInternal {
    return {
      ensureTables: () => this.#ensureTables(),
      getStream: (streamId) => this.#getStream(streamId),
      insertStream: (streamId, tag, metadata) => {
        this.#validateStreamId(streamId);
        const metadataJson = this.#serialize(
          metadata,
          `metadata for stream "${streamId}"`
        );
        const now = Date.now();
        this.#sql`
          INSERT INTO cf_agents_streams
            (stream_id, state, tag, metadata, chunk_count, created_at, updated_at)
          VALUES
            (${streamId}, 'streaming', ${tag}, ${metadataJson}, 0, ${now}, ${now})
        `;
        this.#emit("stream:opened", { streamId });
      },
      append: (streamId, chunk) => this.#append(streamId, chunk),
      lastChunkAt: (streamId) => this.#tail(streamId).lastChunkAt,
      settle: (streamId, state, reason) =>
        this.#settle(streamId, state, reason),
      deleteUnchecked: (streamId) => {
        this.#sql`
          DELETE FROM cf_agents_stream_chunks WHERE stream_id = ${streamId}
        `;
        const removed = this.#sqlWrite(
          "DELETE FROM cf_agents_streams WHERE stream_id = ?",
          [streamId]
        );
        if (removed > 0) this.#emit("stream:deleted", { streamId });
        // Unchecked deletes can remove a live stream: wake tailing readers
        // so they observe the deletion instead of pending forever.
        this.#wake(streamId);
      },
      deleteMany: (streamIds) => {
        for (const streamId of streamIds) {
          this.#sql`
            DELETE FROM cf_agents_stream_chunks WHERE stream_id = ${streamId}
          `;
          this.#sql`DELETE FROM cf_agents_streams WHERE stream_id = ${streamId}`;
          this.#wake(streamId);
        }
      },
      readChunks: (streamId, fromSeq, limit) => this.#sql<StreamChunkRow>`
        SELECT stream_id, seq, chunk, created_at FROM cf_agents_stream_chunks
        WHERE stream_id = ${streamId} AND seq >= ${fromSeq}
        ORDER BY seq ASC
        LIMIT ${limit}
      `,
      listRows: () => this.#sql<StreamRow>`
        SELECT * FROM cf_agents_streams ORDER BY created_at DESC, stream_id DESC
      `,
      rowsByTag: (tag, state) =>
        state
          ? this.#sql<StreamRow>`
              SELECT * FROM cf_agents_streams
              WHERE tag = ${tag} AND state = ${state}
              ORDER BY created_at DESC, stream_id DESC
            `
          : this.#sql<StreamRow>`
              SELECT * FROM cf_agents_streams
              WHERE tag = ${tag}
              ORDER BY created_at DESC, stream_id DESC
            `,
      importStream: (row) => {
        this.#validateStreamId(row.streamId);
        const metadataJson = this.#serialize(
          row.metadata,
          `metadata for stream "${row.streamId}"`
        );
        this.#sql`
          INSERT INTO cf_agents_streams
            (stream_id, state, tag, metadata, chunk_count,
             created_at, updated_at, closed_at)
          VALUES
            (${row.streamId}, ${row.state}, ${row.tag}, ${metadataJson},
             ${row.chunkCount}, ${row.createdAt}, ${row.updatedAt},
             ${row.closedAt})
        `;
      },
      importChunk: (streamId, chunk, createdAt) => {
        const chunkJson = this.#serialize(
          chunk,
          `chunk for stream "${streamId}"`
        );
        const seq = this.#tail(streamId).nextSeq;
        this.#sql`
          INSERT INTO cf_agents_stream_chunks (stream_id, seq, chunk, created_at)
          VALUES (${streamId}, ${seq}, ${chunkJson}, ${createdAt})
        `;
      }
    };
  }

  // ── Writer ───────────────────────────────────────────────────────────────

  #writer(streamId: string): StreamWriter {
    const capability = this;
    return {
      streamId,
      get cursor(): number {
        return capability.#tail(streamId).nextSeq;
      },
      append: (chunk) => this.#append(streamId, chunk),
      close: () => this.#settle(streamId, "completed", null),
      error: (reason) => this.#settle(streamId, "errored", reason ?? null)
    };
  }

  #append(streamId: string, chunk: StreamJson): number {
    // Serialization runs BEFORE the fence read: JSON.stringify can execute
    // user toJSON() methods, which may synchronously re-enter this stream.
    const chunkJson = this.#serialize(chunk, `chunk for stream "${streamId}"`);
    if (chunkJson === null) {
      throw new StreamSerializationError(
        `chunk for stream "${streamId}"`,
        "chunks must not be undefined"
      );
    }
    // The fence is a read, and its atomicity lives in the isolate's
    // threading model: a Durable Object executes one synchronous block at
    // a time, so the state check, tail read, and INSERT below cannot
    // interleave with a settle, delete, or another append. Nothing between
    // here and the INSERT may await or call user code — either would
    // reintroduce the lost-update races the old guarded-UPDATE fence
    // prevented, at the cost of one stream-row write per append.
    const state = this.#state(streamId);
    if (state !== "streaming") {
      throw new StreamClosedError(
        streamId,
        state !== undefined ? `already settled as ${state}` : "it was deleted"
      );
    }
    const seq = this.#tail(streamId).nextSeq;
    this.#sql`
      INSERT INTO cf_agents_stream_chunks (stream_id, seq, chunk, created_at)
      VALUES (${streamId}, ${seq}, ${chunkJson}, ${Date.now()})
    `;
    this.#wake(streamId);
    return seq;
  }

  #settle(
    streamId: string,
    state: Extract<StreamState, "completed" | "errored">,
    reason: string | null
  ): void {
    // Settlement is the moment the stream row becomes exact at rest: the
    // one UPDATE that ends the stream also stamps the final cursor, read
    // from the chunk log's tail in the same synchronous block. While the
    // stream was live, appends wrote only the chunk log — the row's
    // chunk_count and updated_at were not maintained per append.
    const finalCursor = this.#tail(streamId).nextSeq;
    const settled = this.#sqlWrite(
      `UPDATE cf_agents_streams
       SET state = ?, error_message = ?, closed_at = ?, updated_at = ?,
           chunk_count = ?
       WHERE stream_id = ? AND state = 'streaming'`,
      [state, reason, Date.now(), Date.now(), finalCursor, streamId]
    );
    if (settled > 0) {
      this.#emit(state === "completed" ? "stream:closed" : "stream:errored", {
        streamId,
        ...(reason !== null ? { reason } : {})
      });
    }
    // Idempotent for recovery callers; readers re-poll and observe the
    // terminal state either way.
    this.#wake(streamId);
  }

  // ── Live fanout ──────────────────────────────────────────────────────────

  #wake(streamId: string): void {
    const waiters = this.#wakeups.get(streamId);
    if (!waiters) return;
    this.#wakeups.delete(streamId);
    for (const wake of waiters) wake();
  }

  #waitForWakeup(streamId: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.#wakeups.get(streamId) ?? new Set();
      this.#wakeups.set(streamId, waiters);
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        waiters.delete(wake);
        // The last aborted waiter removes the map entry too, so abandoned
        // streams do not accumulate empty sets for the isolate's lifetime.
        if (waiters.size === 0 && this.#wakeups.get(streamId) === waiters) {
          this.#wakeups.delete(streamId);
        }
        // Resolve rather than reject: the read loop re-checks the signal
        // first and throws its reason from generator context.
        resolve();
      };
      waiters.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  #validateStreamId(streamId: string): void {
    if (typeof streamId !== "string" || streamId.length === 0) {
      throw new Error("Stream ids must be non-empty strings");
    }
    if (streamId.length > MAX_STREAM_ID_LENGTH) {
      throw new Error(`Stream id exceeds ${MAX_STREAM_ID_LENGTH} characters`);
    }
  }

  #serialize(value: unknown, context: string): string | null {
    if (value === undefined) return null;
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch (error) {
      throw new StreamSerializationError(
        context,
        error instanceof Error ? error.message : String(error)
      );
    }
    if (json === undefined) {
      throw new StreamSerializationError(
        context,
        `value of type ${typeof value} has no JSON representation`
      );
    }
    const bytes = utf8.encode(json).byteLength;
    if (bytes > this.#maxChunkBytes) {
      throw new StreamSerializationError(
        context,
        `serialized size ${bytes} bytes exceeds the ${this.#maxChunkBytes}-byte limit`
      );
    }
    return json;
  }

  #sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const query = strings.reduce(
      (result, part, index) =>
        result + part + (index < values.length ? "?" : ""),
      ""
    );
    try {
      // SAFETY: Streams queries select from its own schema; T describes the
      // projected columns of the accompanying query text.
      return [...this.lifecycle.storage.sql.exec(query, ...values)] as T[];
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  #sqlWrite(query: string, params: (string | number | null)[]): number {
    try {
      return this.lifecycle.storage.sql.exec(query, ...params).rowsWritten;
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  #getStream(streamId: string): StreamRow | undefined {
    const rows = this.#sql<StreamRow>`
      SELECT * FROM cf_agents_streams WHERE stream_id = ${streamId}
    `;
    return rows[0];
  }

  /**
   * One stream's state alone — the narrow read for the append fence and the
   * reader loop's liveness checks, which need neither the metadata column
   * nor the (live-stale) counters of the full row.
   */
  #state(streamId: string): StreamState | undefined {
    const rows = this.#sql<{ state: StreamState }>`
      SELECT state FROM cf_agents_streams WHERE stream_id = ${streamId}
    `;
    return rows[0]?.state;
  }

  /**
   * The chunk log's tail: the next append sequence and the newest chunk's
   * timestamp. One PK-served read (`ORDER BY seq DESC LIMIT 1`), and the
   * single derivation point for every cursor and per-append-liveness
   * consumer — while a stream is live, the chunk log is authoritative and
   * the stream row's `chunk_count`/`updated_at` are not maintained.
   */
  #tail(streamId: string): { nextSeq: number; lastChunkAt: number | null } {
    const rows = this.#sql<{ seq: number; created_at: number }>`
      SELECT seq, created_at FROM cf_agents_stream_chunks
      WHERE stream_id = ${streamId}
      ORDER BY seq DESC
      LIMIT 1
    `;
    const tail = rows[0];
    return tail
      ? { nextSeq: tail.seq + 1, lastChunkAt: tail.created_at }
      : { nextSeq: 0, lastChunkAt: null };
  }

  #rowToStatus(row: StreamRow): StreamStatus {
    // A live row's stored counters are stale by design (appends write only
    // the chunk log), so cursor and updatedAt are derived from the tail;
    // terminal rows were stamped exact at settle and read straight through.
    let cursor = row.chunk_count;
    let updatedAt = row.updated_at;
    if (row.state === "streaming") {
      const tail = this.#tail(row.stream_id);
      cursor = tail.nextSeq;
      if (tail.lastChunkAt !== null && tail.lastChunkAt > updatedAt) {
        updatedAt = tail.lastChunkAt;
      }
    }
    return {
      streamId: row.stream_id,
      state: row.state,
      cursor,
      ...(row.tag !== null ? { tag: row.tag } : {}),
      ...(row.metadata !== null
        ? {
            metadata: JSON.parse(row.metadata) as Record<string, StreamJson>
          }
        : {}),
      ...(row.error_message !== null ? { error: row.error_message } : {}),
      createdAt: row.created_at,
      updatedAt,
      ...(row.closed_at !== null ? { closedAt: row.closed_at } : {})
    };
  }

  #ensureTables(): void {
    const rawSql = (query: string) => {
      try {
        this.lifecycle.storage.sql.exec(query);
      } catch (cause) {
        throw new SqlError(query, cause);
      }
    };
    // Both tables are WITHOUT ROWID: Cloudflare bills index maintenance as
    // rows written, and an ordinary rowid table maintains a hidden UNIQUE
    // index for its PRIMARY KEY — one extra billed row on every INSERT and
    // DELETE. WITHOUT ROWID makes the PK the table itself, so a chunk
    // append bills exactly one row (see the write-accounting test).
    rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_streams (
        stream_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN (
          'streaming', 'completed', 'errored'
        )),
        tag TEXT,
        metadata TEXT,
        error_message TEXT,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      ) WITHOUT ROWID
    `);
    rawSql(`
      CREATE INDEX IF NOT EXISTS idx_cf_agents_streams_tag
      ON cf_agents_streams(tag, created_at)
    `);
    rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_stream_chunks (
        stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        chunk TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (stream_id, seq)
      ) WITHOUT ROWID
    `);
  }

  #emit(type: string, payload: Record<string, unknown>): void {
    this.lifecycle.events.emit(type, payload);
  }
}
