/**
 * ResumableStream: Standalone class for buffering, persisting, and replaying
 * stream chunks in SQLite. Extracted from AIChatAgent to separate concerns.
 *
 * Handles:
 * - Chunk buffering (batched writes to SQLite for performance)
 * - Stream lifecycle (start, complete, error)
 * - Chunk replay for reconnecting clients
 * - Stale stream cleanup
 * - Active stream restoration after agent restart
 */

import { nanoid } from "nanoid";
import type { Connection } from "agents";
import { CHAT_MESSAGE_TYPES } from "./protocol";
import { sendIfOpen } from "./connection";

/** Number of chunks to pack into a single SQLite row before flushing */
const CHUNK_BUFFER_SIZE = 10;
/** Maximum buffer size to prevent memory issues on rapid reconnections */
const CHUNK_BUFFER_MAX_SIZE = 100;
/**
 * Max accumulated raw chunk bytes packed into one row before forcing a flush.
 * The SQLite row limit is 2 MB; packing serializes bodies into a JSON array,
 * which re-escapes their contents (quotes/backslashes), so we keep the raw
 * total well under the limit to leave generous headroom for escaping overhead.
 * A chunk larger than this is flushed as its own (unwrapped) row.
 */
const SEGMENT_MAX_BYTES = 512_000;
/** Default cleanup interval for old streams (ms) - every 10 minutes */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
/**
 * Retention for completed/errored stream buffers, measured from completion.
 *
 * The assistant message is persisted separately (`cf_ai_chat_agent_messages`),
 * so once a stream completes its buffer is no longer the source of truth — it
 * is only a brief reconnect-and-replay grace window: long enough to cover a
 * client that dropped at the completion boundary and reconnects to replay the
 * just-finished stream, and to deliver a pending terminal error frame on a
 * resumed stream (#1645). It is deliberately short (not the chat's lifetime)
 * so idle/one-off chat DOs don't accumulate stale buffers (#1706).
 */
const COMPLETED_RETENTION_MS = 10 * 60 * 1000;
/**
 * Retention for abandoned `streaming` rows, measured from LAST chunk activity.
 *
 * Generous relative to {@link COMPLETED_RETENTION_MS}: an interrupted turn must
 * have ample time to be resumed by a reconnecting client or healed by fiber
 * recovery before its buffer is reaped. Only a stream that has produced no
 * chunk for this long is treated as truly dead. Keyed off last activity (not
 * start time) so a long but still-active stream is never swept mid-flight.
 */
const ABANDONED_STREAM_RETENTION_MS = 60 * 60 * 1000;
/** Shared encoder for UTF-8 byte length measurement */
const textEncoder = new TextEncoder();

/**
 * How far ahead (seconds) to schedule the resumable-stream buffer cleanup
 * alarm. Set to the short completion-grace window ({@link COMPLETED_RETENTION_MS},
 * 10m) so a finished buffer is reclaimed promptly. The re-arm-while-reclaimable
 * loop (see {@link cleanupStreamBuffers}) revisits any longer-lived rows — e.g.
 * an abandoned in-flight buffer on its 1h window — by waking again each interval
 * until they age out, then stops. Driving cleanup from an alarm (rather than
 * only piggybacking on the next stream completion) ensures idle/one-off chat
 * DOs still reclaim their buffers without waking forever (#1706). Shared by
 * `AIChatAgent` and `Think`.
 */
export const STREAM_CLEANUP_DELAY_SECONDS = 10 * 60;

/**
 * A stored row body is either a single chunk body (a JSON object string —
 * legacy per-chunk rows and single-chunk segments) or a packed segment (a JSON
 * array of chunk body strings). Unpack to the individual chunk bodies in order.
 *
 * Stored chunk bodies are always serialized JSON *objects*, never arrays, so
 * `Array.isArray` reliably distinguishes a packed segment from a single body.
 */
function unpackSegmentBody(rowBody: string): string[] {
  try {
    const parsed = JSON.parse(rowBody);
    if (Array.isArray(parsed)) {
      return parsed as string[];
    }
  } catch {
    // Not valid JSON — treat as a single opaque body.
  }
  return [rowBody];
}

function isMissingMetadataColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    (message.includes("message_id") || message.includes("is_continuation")) &&
    (message.toLowerCase().includes("no such column") ||
      message.toLowerCase().includes("has no column named"))
  );
}

/**
 * Stored stream chunk for resumable streaming
 */
type StreamChunk = {
  id: string;
  stream_id: string;
  body: string;
  chunk_index: number;
  created_at: number;
};

/**
 * Stream metadata for tracking active streams
 */
type StreamMetadata = {
  id: string;
  request_id: string;
  status: "streaming" | "completed" | "error";
  created_at: number;
  completed_at: number | null;
  /**
   * The assistant message id this stream is producing, captured when the
   * stream starts. This is the SAME id the live path persists under, so orphan
   * recovery (#1691) can re-associate reconstructed chunks with the correct
   * message even when the provider stream carries no `start.messageId`. Null on
   * legacy rows written before this column existed.
   */
  message_id: string | null;
  /**
   * Whether this stream is a continuation (appends to the last assistant
   * message rather than starting a new one). Live broadcast frames carry
   * `continuation: true`, and replay frames must too (#1733): without it a
   * reconnecting client treats a replayed continuation as a fresh message
   * and drops the parts streamed before the continuation. SQLite has no
   * boolean type — 1/0/null (legacy rows predating the column).
   */
  is_continuation: number | null;
};

/**
 * Minimal SQL interface matching Agent's this.sql tagged template.
 * Allows ResumableStream to work with the Agent's SQLite without
 * depending on the full Agent class.
 */
export type SqlTaggedTemplate = {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
};

export class ResumableStream {
  private _activeStreamId: string | null = null;
  private _activeRequestId: string | null = null;
  /** Monotonic row-ordering index; one increment per flushed segment row. */
  private _segmentIndex = 0;

  /**
   * Whether the active stream was started in this instance (true) or
   * restored from SQLite after hibernation/restart (false). An orphaned
   * stream has no live LLM reader — the ReadableStream was lost when the
   * DO was evicted.
   */
  private _isLive = false;

  /**
   * Whether the active stream is a continuation. Mirrors the durable
   * `is_continuation` column so replay frames can carry the flag without a
   * per-replay query; restored from SQLite after hibernation in restore().
   */
  private _activeIsContinuation = false;

  private _chunkBuffer: Array<{ streamId: string; body: string }> = [];
  private _chunkBufferBytes = 0;
  private _isFlushingChunks = false;
  private _lastCleanupTime = 0;

  constructor(private sql: SqlTaggedTemplate) {
    // Create tables for stream chunks and metadata
    this.sql`create table if not exists cf_ai_chat_stream_chunks (
      id text primary key,
      stream_id text not null,
      body text not null,
      chunk_index integer not null,
      created_at integer not null
    )`;

    this.sql`create table if not exists cf_ai_chat_stream_metadata (
      id text primary key,
      request_id text not null,
      status text not null,
      created_at integer not null,
      completed_at integer,
      message_id text,
      is_continuation integer
    )`;

    this.sql`create index if not exists idx_stream_chunks_stream_id 
      on cf_ai_chat_stream_chunks(stream_id, chunk_index)`;

    // Restore any active stream from a previous session
    this.restore();
  }

  /**
   * Add metadata columns for rows created before they existed. Constructors
   * intentionally do not run this: most wakes never start a stream, so paying a
   * schema-introspection read every time is wasteful. New tables include these
   * columns in CREATE TABLE; legacy tables migrate lazily only if a write/read
   * discovers the columns are missing.
   */
  private _migrateMetadataColumns() {
    const columns =
      this.sql<{ name: string }>`
        select name from pragma_table_info('cf_ai_chat_stream_metadata')
      ` ?? [];
    const hasMessageId = columns.some((column) => column.name === "message_id");
    if (!hasMessageId) {
      this
        .sql`alter table cf_ai_chat_stream_metadata add column message_id text`;
    }
    const hasIsContinuation = columns.some(
      (column) => column.name === "is_continuation"
    );
    if (!hasIsContinuation) {
      this
        .sql`alter table cf_ai_chat_stream_metadata add column is_continuation integer`;
    }
  }

  // ── State accessors ────────────────────────────────────────────────

  get activeStreamId(): string | null {
    return this._activeStreamId;
  }

  get activeRequestId(): string | null {
    return this._activeRequestId;
  }

  hasActiveStream(): boolean {
    return this._activeStreamId !== null;
  }

  /**
   * Whether the active stream has a live LLM reader (started in this
   * instance) vs being restored from SQLite after hibernation (orphaned).
   */
  get isLive(): boolean {
    return this._isLive;
  }

  // ── Stream lifecycle ───────────────────────────────────────────────

  /**
   * Start tracking a new stream for resumable streaming.
   * Creates metadata entry in SQLite and sets up tracking state.
   * @param requestId - The unique ID of the chat request
   * @returns The generated stream ID
   */
  start(
    requestId: string,
    options: { messageId?: string; continuation?: boolean } = {}
  ): string {
    // Flush any pending chunks from previous streams to prevent mixing
    this.flushBuffer();

    const streamId = nanoid();
    this._activeStreamId = streamId;
    this._activeRequestId = requestId;
    this._segmentIndex = 0;
    this._isLive = true;
    this._activeIsContinuation = options.continuation ?? false;

    const messageId = options.messageId ?? null;

    try {
      this.sql`
        insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at, message_id, is_continuation)
        values (${streamId}, ${requestId}, 'streaming', ${Date.now()}, ${messageId}, ${this._activeIsContinuation ? 1 : 0})
      `;
    } catch (error) {
      if (!isMissingMetadataColumnError(error)) throw error;
      this._migrateMetadataColumns();
      this.sql`
        insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at, message_id, is_continuation)
        values (${streamId}, ${requestId}, 'streaming', ${Date.now()}, ${messageId}, ${this._activeIsContinuation ? 1 : 0})
      `;
    }

    return streamId;
  }

  /**
   * The assistant message id an orphaned stream was producing — the same id the
   * live path persists under, so recovery re-associates reconstructed chunks
   * with the correct message (#1691). Returns null when the row is missing or
   * is a legacy row written before the `message_id` column existed.
   */
  getStreamMessageId(streamId: string): string | null {
    let rows: Array<{ message_id: string | null }>;
    try {
      rows = this.sql<{ message_id: string | null }>`
        select message_id from cf_ai_chat_stream_metadata
        where id = ${streamId}
      `;
    } catch (error) {
      if (!isMissingMetadataColumnError(error)) throw error;
      return null;
    }
    if (!rows || rows.length === 0) return null;
    return rows[0].message_id ?? null;
  }

  /**
   * Mark a stream as completed and flush any pending chunks.
   * @param streamId - The stream to mark as completed
   */
  complete(streamId: string) {
    this.flushBuffer();

    this.sql`
      update cf_ai_chat_stream_metadata 
      set status = 'completed', completed_at = ${Date.now()} 
      where id = ${streamId}
    `;
    this._activeStreamId = null;
    this._activeRequestId = null;
    this._segmentIndex = 0;
    this._isLive = false;
    this._activeIsContinuation = false;

    // Periodically clean up old streams
    this._maybeCleanupOldStreams();
  }

  /**
   * Mark a stream as errored and clean up state.
   * @param streamId - The stream to mark as errored
   */
  markError(streamId: string) {
    this.flushBuffer();

    this.sql`
      update cf_ai_chat_stream_metadata 
      set status = 'error', completed_at = ${Date.now()} 
      where id = ${streamId}
    `;
    this._activeStreamId = null;
    this._activeRequestId = null;
    this._segmentIndex = 0;
    this._isLive = false;
    this._activeIsContinuation = false;
  }

  // ── Chunk storage ──────────────────────────────────────────────────

  /** Maximum chunk body size before skipping storage (bytes). Prevents SQLite row limit crash. */
  private static CHUNK_MAX_BYTES = 1_800_000;

  /**
   * Buffer a stream chunk for batch write to SQLite.
   * Chunks exceeding the row size limit are skipped to prevent crashes.
   * The chunk is still broadcast to live clients (caller handles that),
   * but will be missing from replay on reconnection.
   * @param streamId - The stream this chunk belongs to
   * @param body - The serialized chunk body
   */
  storeChunk(streamId: string, body: string) {
    // Guard against chunks that would exceed SQLite row limit.
    // The chunk is still broadcast to live clients; only replay storage is skipped.
    const bodyBytes = textEncoder.encode(body).byteLength;
    if (bodyBytes > ResumableStream.CHUNK_MAX_BYTES) {
      console.warn(
        `[ResumableStream] Skipping oversized chunk (${bodyBytes} bytes) ` +
          `to prevent SQLite row limit crash. Live clients still receive it.`
      );
      return;
    }

    // Force flush if buffer is at max to prevent memory issues
    if (this._chunkBuffer.length >= CHUNK_BUFFER_MAX_SIZE) {
      this.flushBuffer();
    }

    // Byte guard: keep a packed segment safely under the SQLite row limit. If
    // the buffer already holds chunks and adding this body would push the
    // segment past the threshold, flush first so this chunk starts a fresh
    // segment. A single large chunk therefore ends up alone and is written
    // unwrapped by flushBuffer (no array-escaping inflation).
    if (
      this._chunkBuffer.length > 0 &&
      this._chunkBufferBytes + bodyBytes > SEGMENT_MAX_BYTES
    ) {
      this.flushBuffer();
    }

    this._chunkBuffer.push({ streamId, body });
    this._chunkBufferBytes += bodyBytes;

    // Flush when buffer reaches the per-segment chunk threshold
    if (this._chunkBuffer.length >= CHUNK_BUFFER_SIZE) {
      this.flushBuffer();
    }
  }

  /**
   * Flush the buffered chunks to SQLite as a single packed row.
   * Uses a lock to prevent concurrent flush operations.
   *
   * The whole buffer becomes one row: a single-chunk segment is stored
   * unwrapped (legacy object format) so a large chunk avoids array-escaping
   * inflation, while a multi-chunk segment stores a JSON array of bodies. This
   * collapses N chunk rows into one, cutting rows written / stored / scanned.
   */
  flushBuffer() {
    if (this._isFlushingChunks || this._chunkBuffer.length === 0) {
      return;
    }

    this._isFlushingChunks = true;
    try {
      const chunks = this._chunkBuffer;
      this._chunkBuffer = [];
      this._chunkBufferBytes = 0;

      // All chunks in a buffer belong to the same stream: start() flushes
      // before switching streams, so the buffer is never cross-stream.
      const streamId = chunks[0].streamId;
      const segmentBody =
        chunks.length === 1
          ? chunks[0].body
          : JSON.stringify(chunks.map((chunk) => chunk.body));

      this.sql`
        insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at)
        values (${nanoid()}, ${streamId}, ${segmentBody}, ${this._segmentIndex}, ${Date.now()})
      `;
      this._segmentIndex++;
    } finally {
      this._isFlushingChunks = false;
    }
  }

  // ── Chunk replay ───────────────────────────────────────────────────

  /**
   * Send stored stream chunks to a connection for replay.
   * Chunks are marked with replay: true so the client can batch-apply them.
   *
   * Three outcomes:
   * - **Live stream**: sends chunks + `replayComplete` — client flushes and
   *   continues receiving live chunks from the LLM reader.
   * - **Orphaned stream** (restored from SQLite after hibernation, no reader):
   *   sends chunks + `done` and completes the stream. The caller should
   *   reconstruct and persist the partial message from the stored chunks.
   * - **Completed during replay** (defensive): sends chunks + `done`.
   *
   * All sends use {@link sendIfOpen}, so a WebSocket closing mid-replay
   * does not throw. If the connection drops while iterating chunks the
   * stream is left active so the next reconnect can retry.
   *
   * @param connection - The WebSocket connection
   * @param requestId - The original request ID
   * @returns The stream ID if the stream was orphaned and finalized, null otherwise.
   *          When non-null the caller should reconstruct the message from chunks.
   */
  replayChunks(connection: Connection, requestId: string): string | null {
    const streamId = this._activeStreamId;
    if (!streamId) return null;

    this.flushBuffer();

    // Replay frames must mirror what a live client observed — including the
    // continuation flag (#1733): a replayed continuation `start` that lacks
    // it would be treated as a fresh message by the client and drop the
    // parts streamed before the continuation.
    const continuation = this._activeIsContinuation;

    const chunks = this.sql<StreamChunk>`
      select * from cf_ai_chat_stream_chunks 
      where stream_id = ${streamId} 
      order by chunk_index asc
    `;

    for (const chunk of chunks || []) {
      for (const body of unpackSegmentBody(chunk.body)) {
        if (
          !sendIfOpen(
            connection,
            JSON.stringify({
              body,
              done: false,
              id: requestId,
              type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
              replay: true,
              ...(continuation && { continuation: true })
            })
          )
        ) {
          // Connection closed mid-replay — leave the stream active so the
          // next reconnect can retry from the start.
          return null;
        }
      }
    }

    if (this._activeStreamId !== streamId) {
      // Stream completed between our check above and now — send done.
      // In practice this cannot happen (DO is single-threaded and replay is
      // synchronous), but we guard defensively in case the flow changes.
      sendIfOpen(
        connection,
        JSON.stringify({
          body: "",
          done: true,
          id: requestId,
          type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
          replay: true,
          ...(continuation && { continuation: true })
        })
      );
      return null;
    }

    if (!this._isLive) {
      // Orphaned stream — restored from SQLite after hibernation but the
      // LLM ReadableStream reader was lost. No more live chunks will ever
      // arrive, so finalize it: best-effort send done, then mark completed
      // in SQLite. The orphan-cleanup decision is committed regardless of
      // whether this particular connection received the done frame, so the
      // caller can persist the reconstructed message.
      sendIfOpen(
        connection,
        JSON.stringify({
          body: "",
          done: true,
          id: requestId,
          type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
          replay: true,
          ...(continuation && { continuation: true })
        })
      );
      this.complete(streamId);
      return streamId;
    }

    // Stream is still active with a live reader — signal that replay is
    // complete so the client can flush accumulated parts to React state.
    // Without this, replayed chunks sit in activeStreamRef unflushed
    // until the next live chunk arrives.
    sendIfOpen(
      connection,
      JSON.stringify({
        body: "",
        done: false,
        id: requestId,
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        replay: true,
        replayComplete: true,
        ...(continuation && { continuation: true })
      })
    );
    return null;
  }

  replayCompletedChunksByRequestId(
    connection: Connection,
    requestId: string
  ): boolean {
    const stream = this._latestStreamForRequest(requestId, "completed");
    if (!stream) return false;

    const continuation = stream.is_continuation === 1;
    if (
      !this._replayStoredChunks(connection, stream.id, requestId, continuation)
    ) {
      return false;
    }

    return sendIfOpen(
      connection,
      JSON.stringify({
        body: "",
        done: true,
        id: requestId,
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        replay: true,
        ...(continuation && { continuation: true })
      })
    );
  }

  /**
   * Replay the stored chunks of an errored stream for a request, WITHOUT a
   * terminal frame — the caller follows up with the `done: true, error: true`
   * frame carrying the durable terminal record's error text, mirroring what a
   * live client observed (content chunks, then the error). Without this, a
   * client that missed broadcast frames while disconnected has no other
   * channel to the pre-error partial content: the server does not push
   * messages on connect, and {@link replayCompletedChunksByRequestId} only
   * serves `completed` streams (#1575).
   *
   * Returns true when the caller should proceed to send its terminal frame:
   * either no errored stream existed (nothing to replay) or its chunks were
   * replayed successfully. Returns false only when a send failed mid-replay,
   * signalling the caller to skip the terminal frame — the connection is gone
   * and the next reconnect retries the whole sequence.
   */
  replayErroredChunksByRequestId(
    connection: Connection,
    requestId: string
  ): boolean {
    const stream = this._latestStreamForRequest(requestId, "error");
    if (!stream) return true;

    return this._replayStoredChunks(
      connection,
      stream.id,
      requestId,
      stream.is_continuation === 1
    );
  }

  /** Latest stream row for a request with the given terminal status. */
  private _latestStreamForRequest(
    requestId: string,
    status: "completed" | "error"
  ): StreamMetadata | undefined {
    this.flushBuffer();

    const streams = this.sql<StreamMetadata>`
      select * from cf_ai_chat_stream_metadata
      where request_id = ${requestId}
      and status = ${status}
      order by created_at desc
      limit 1
    `;
    return streams[0];
  }

  /**
   * Send a finished stream's stored chunks to a connection as replay frames.
   * Returns false if the connection closed mid-replay.
   */
  private _replayStoredChunks(
    connection: Connection,
    streamId: string,
    requestId: string,
    continuation = false
  ): boolean {
    const chunks = this.sql<StreamChunk>`
      select * from cf_ai_chat_stream_chunks
      where stream_id = ${streamId}
      order by chunk_index asc
    `;

    for (const chunk of chunks || []) {
      for (const body of unpackSegmentBody(chunk.body)) {
        if (
          !sendIfOpen(
            connection,
            JSON.stringify({
              body,
              done: false,
              id: requestId,
              type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
              replay: true,
              ...(continuation && { continuation: true })
            })
          )
        ) {
          return false;
        }
      }
    }

    return true;
  }

  // ── Restore / cleanup ──────────────────────────────────────────────

  /**
   * Restore active stream state if the agent was restarted during streaming.
   * All streams are restored regardless of age — stale cleanup happens
   * lazily in _maybeCleanupOldStreams after recovery has had its chance.
   */
  restore() {
    const activeStreams = this.sql<StreamMetadata>`
      select * from cf_ai_chat_stream_metadata 
      where status = 'streaming' 
      order by created_at desc 
      limit 1
    `;

    if (activeStreams && activeStreams.length > 0) {
      const stream = activeStreams[0];
      this._activeStreamId = stream.id;
      this._activeRequestId = stream.request_id;
      // Rehydrate the continuation flag so an orphaned continuation stream
      // replayed after hibernation still carries `continuation: true` on
      // its frames (#1733). Legacy rows predate the column → null → false.
      this._activeIsContinuation = stream.is_continuation === 1;

      // Resume the segment row-ordering index past the highest stored value.
      const lastChunk = this.sql<{ max_index: number }>`
        select max(chunk_index) as max_index 
        from cf_ai_chat_stream_chunks 
        where stream_id = ${this._activeStreamId}
      `;
      this._segmentIndex =
        lastChunk && lastChunk[0]?.max_index != null
          ? lastChunk[0].max_index + 1
          : 0;
    }
  }

  /**
   * Clear all stream data (called on chat history clear).
   */
  clearAll() {
    this._chunkBuffer = [];
    this._chunkBufferBytes = 0;
    this.sql`delete from cf_ai_chat_stream_chunks`;
    this.sql`delete from cf_ai_chat_stream_metadata`;
    this._activeStreamId = null;
    this._activeRequestId = null;
    this._segmentIndex = 0;
    this._activeIsContinuation = false;
  }

  /**
   * Drop all stream tables (called on destroy).
   */
  destroy() {
    this.flushBuffer();
    this.sql`drop table if exists cf_ai_chat_stream_chunks`;
    this.sql`drop table if exists cf_ai_chat_stream_metadata`;
    this._activeStreamId = null;
    this._activeRequestId = null;
    this._activeIsContinuation = false;
  }

  /**
   * Force a sweep of aged stream buffers now, bypassing the lazy interval
   * gate used by {@link _maybeCleanupOldStreams}. Intended to be driven by an
   * alarm so idle/hibernated chat DOs still reclaim buffers even when no
   * further stream ever completes to trigger the lazy path.
   */
  cleanup(now: number = Date.now()): void {
    this._lastCleanupTime = now;
    this._sweepOldStreams(now);
  }

  /**
   * True if any stream rows remain at all. Used by alarm-driven cleanup to
   * decide whether to re-arm: once no rows remain there is nothing left to
   * sweep, so the DO can stop waking itself.
   */
  hasReclaimableStreams(): boolean {
    const rows = this.sql<{ n: number }>`
      select count(*) as n from cf_ai_chat_stream_metadata
    `;
    return (rows?.[0]?.n ?? 0) > 0;
  }

  // ── Internal ───────────────────────────────────────────────────────

  private _maybeCleanupOldStreams() {
    const now = Date.now();
    if (now - this._lastCleanupTime < CLEANUP_INTERVAL_MS) {
      return;
    }
    this._lastCleanupTime = now;
    this._sweepOldStreams(now);
  }

  /** Delete completed/errored buffers past the completion grace window, plus
   *  abandoned "streaming" rows past the stale-in-flight window. The two use
   *  different retentions: a completed buffer is redundant with the persisted
   *  message and needs only a brief replay grace, whereas an in-flight buffer
   *  must outlive resume/recovery before it is presumed dead. */
  private _sweepOldStreams(now: number) {
    const completedCutoff = now - COMPLETED_RETENTION_MS;
    this.sql`
      delete from cf_ai_chat_stream_chunks 
      where stream_id in (
        select id from cf_ai_chat_stream_metadata 
        where status in ('completed', 'error') and completed_at < ${completedCutoff}
      )
    `;
    this.sql`
      delete from cf_ai_chat_stream_metadata 
      where status in ('completed', 'error') and completed_at < ${completedCutoff}
    `;

    // Clean up abandoned "streaming" rows. These are orphaned streams that
    // were never completed or recovered (e.g. non-durable agents that never
    // reconnected). By this point, fiber recovery has already had its chance
    // to claim them — safe to delete.
    //
    // "Abandoned" is keyed off LAST ACTIVITY (the most recent chunk write),
    // not the stream's start time: a long-running stream that is still
    // actively emitting chunks must never be swept mid-flight just because it
    // started long ago. A row with no chunks falls back to its start time.
    // Note `created_at <= max(chunk.created_at)` always (the row is inserted
    // before any chunk), so this set is stable across the two deletes even
    // though the first removes the chunks the second's subquery reads.
    const abandonedCutoff = now - ABANDONED_STREAM_RETENTION_MS;
    this.sql`
      delete from cf_ai_chat_stream_chunks
      where stream_id in (
        select m.id from cf_ai_chat_stream_metadata m
        where m.status = 'streaming'
          and coalesce(
            (select max(c.created_at) from cf_ai_chat_stream_chunks c
             where c.stream_id = m.id),
            m.created_at
          ) < ${abandonedCutoff}
      )
    `;
    this.sql`
      delete from cf_ai_chat_stream_metadata
      where id in (
        select m.id from cf_ai_chat_stream_metadata m
        where m.status = 'streaming'
          and coalesce(
            (select max(c.created_at) from cf_ai_chat_stream_chunks c
             where c.stream_id = m.id),
            m.created_at
          ) < ${abandonedCutoff}
      )
    `;
  }

  // ── Test helpers (matching old AIChatAgent test API) ────────────────

  /**
   * Return the stored chunks for a stream as individual chunk bodies in order,
   * unpacking packed segment rows. The returned `chunk_index` is a running
   * per-chunk sequence (0, 1, 2, …) — stable across calls because rows are
   * append-only — so callers can use it as a monotonic chunk sequence.
   */
  getStreamChunks(
    streamId: string
  ): Array<{ body: string; chunk_index: number }> {
    const rows =
      this.sql<{ body: string }>`
        select body from cf_ai_chat_stream_chunks 
        where stream_id = ${streamId} 
        order by chunk_index asc
      ` || [];
    const out: Array<{ body: string; chunk_index: number }> = [];
    let index = 0;
    for (const row of rows) {
      for (const body of unpackSegmentBody(row.body)) {
        out.push({ body, chunk_index: index });
        index++;
      }
    }
    return out;
  }

  /** @internal For testing only */
  getStreamMetadata(
    streamId: string
  ): { status: string; request_id: string } | null {
    const result = this.sql<{ status: string; request_id: string }>`
      select status, request_id from cf_ai_chat_stream_metadata 
      where id = ${streamId}
    `;
    return result && result.length > 0 ? result[0] : null;
  }

  /** @internal For testing only */
  getAllStreamMetadata(): Array<{
    id: string;
    status: string;
    request_id: string;
    created_at: number;
  }> {
    return (
      this.sql<{
        id: string;
        status: string;
        request_id: string;
        created_at: number;
      }>`select id, status, request_id, created_at from cf_ai_chat_stream_metadata` ||
      []
    );
  }

  /** @internal For testing only */
  insertStaleStream(streamId: string, requestId: string, ageMs: number): void {
    const createdAt = Date.now() - ageMs;
    this.sql`
      insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at)
      values (${streamId}, ${requestId}, 'streaming', ${createdAt})
    `;
  }

  /**
   * Append a chunk to a stream dated `ageMs` in the past. Used to exercise the
   * last-activity sweep threshold: a long-running streaming row with a *recent*
   * chunk must survive even when its start time is older than the cutoff.
   * @internal For testing only
   */
  insertChunkAt(streamId: string, body: string, ageMs: number): void {
    const createdAt = Date.now() - ageMs;
    this.sql`
      insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at)
      values (${nanoid()}, ${streamId}, ${body}, 0, ${createdAt})
    `;
  }
}

/**
 * The buffer-cleanup alarm body: sweep aged stream buffers, then re-arm only
 * while rows remain so a fully-swept DO stops waking itself. `rearm` schedules
 * the next sweep — it MUST schedule a non-idempotent alarm, because this runs
 * INSIDE the currently-executing one-shot schedule row, which `alarm()` deletes
 * only after it returns; an idempotent reschedule would dedup onto that row and
 * be deleted with it, so the re-arm would silently never fire and buffers that
 * survived this sweep (e.g. a younger turn) would go uncollected. A fresh
 * delayed row survives the deletion. Shared by `AIChatAgent` and `Think`.
 *
 * `@internal`
 */
export async function cleanupStreamBuffers(
  stream: Pick<ResumableStream, "cleanup" | "hasReclaimableStreams">,
  rearm: () => Promise<void>
): Promise<void> {
  stream.cleanup();
  if (stream.hasReclaimableStreams()) {
    await rearm();
  }
}
