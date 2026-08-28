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
      return this.#writer(streamId);
    }

    const metadataJson = this.#serialize(
      options.metadata,
      `metadata for stream "${streamId}"`
    );
    const now = Date.now();
    this.#sql`
      INSERT INTO cf_agents_streams
        (stream_id, state, metadata, chunk_count, created_at, updated_at)
      VALUES
        (${streamId}, 'streaming', ${metadataJson}, 0, ${now}, ${now})
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
    await this.lifecycle.ready();
    const signal = options.signal;
    let next = Math.max(0, options.from ?? 0);

    if (!this.#getStream(streamId)) {
      throw new StreamNotFoundError(streamId);
    }

    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("Read aborted");

      const rows = this.#sql<StreamChunkRow>`
        SELECT stream_id, seq, chunk, created_at FROM cf_agents_stream_chunks
        WHERE stream_id = ${streamId} AND seq >= ${next}
        ORDER BY seq ASC
        LIMIT ${READ_BATCH_SIZE}
      `;
      for (const row of rows) {
        if (signal?.aborted) throw signal.reason ?? new Error("Read aborted");
        yield { seq: row.seq, chunk: JSON.parse(row.chunk) as StreamJson };
        next = row.seq + 1;
      }
      if (rows.length === READ_BATCH_SIZE) continue;

      const stream = this.#getStream(streamId);
      if (!stream) return; // deleted mid-read: nothing further to yield
      if (stream.state !== "streaming" && stream.chunk_count <= next) return;
      if (stream.state !== "streaming") continue; // drain the rest first

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

  // ── Writer ───────────────────────────────────────────────────────────────

  #writer(streamId: string): StreamWriter {
    const capability = this;
    return {
      streamId,
      get cursor(): number {
        return capability.#getStream(streamId)?.chunk_count ?? 0;
      },
      append: (chunk) => this.#append(streamId, chunk),
      close: () => this.#settle(streamId, "completed", null),
      error: (reason) => this.#settle(streamId, "errored", reason ?? null)
    };
  }

  #append(streamId: string, chunk: StreamJson): number {
    const chunkJson = this.#serialize(chunk, `chunk for stream "${streamId}"`);
    if (chunkJson === null) {
      throw new StreamSerializationError(
        `chunk for stream "${streamId}"`,
        "chunks must not be undefined"
      );
    }
    // The count bump is the write fence: it only succeeds while the stream
    // is live, and the pre-bump count is the appended chunk's sequence.
    const bumped = this.#sqlWrite(
      `UPDATE cf_agents_streams
       SET chunk_count = chunk_count + 1, updated_at = ?
       WHERE stream_id = ? AND state = 'streaming'`,
      [Date.now(), streamId]
    );
    if (bumped === 0) {
      const row = this.#getStream(streamId);
      throw new StreamClosedError(
        streamId,
        row ? `already settled as ${row.state}` : "it was deleted"
      );
    }
    const row = this.#getStream(streamId);
    const seq = (row?.chunk_count ?? 1) - 1;
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
    const settled = this.#sqlWrite(
      `UPDATE cf_agents_streams
       SET state = ?, error_message = ?, closed_at = ?, updated_at = ?
       WHERE stream_id = ? AND state = 'streaming'`,
      [state, reason, Date.now(), Date.now(), streamId]
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

  #rowToStatus(row: StreamRow): StreamStatus {
    return {
      streamId: row.stream_id,
      state: row.state,
      cursor: row.chunk_count,
      ...(row.metadata !== null
        ? {
            metadata: JSON.parse(row.metadata) as Record<string, StreamJson>
          }
        : {}),
      ...(row.error_message !== null ? { error: row.error_message } : {}),
      createdAt: row.created_at,
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
    rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_streams (
        stream_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN (
          'streaming', 'completed', 'errored'
        )),
        metadata TEXT,
        error_message TEXT,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      )
    `);
    rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_stream_chunks (
        stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        chunk TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (stream_id, seq)
      )
    `);
  }

  #emit(type: string, payload: Record<string, unknown>): void {
    this.lifecycle.events.emit(type, payload);
  }
}
