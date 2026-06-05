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
/** Default age threshold for cleaning up completed streams (ms) - 24 hours */
const CLEANUP_AGE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
/** Shared encoder for UTF-8 byte length measurement */
const textEncoder = new TextEncoder();

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

function sendIfOpen(connection: Connection, message: string): boolean {
  try {
    connection.send(message);
    return true;
  } catch (error) {
    if (isWebSocketClosedSendError(error)) return false;
    throw error;
  }
}

function isWebSocketClosedSendError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes("WebSocket send() after close")
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
      completed_at integer
    )`;

    this.sql`create index if not exists idx_stream_chunks_stream_id 
      on cf_ai_chat_stream_chunks(stream_id, chunk_index)`;

    // Restore any active stream from a previous session
    this.restore();
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
  start(requestId: string): string {
    // Flush any pending chunks from previous streams to prevent mixing
    this.flushBuffer();

    const streamId = nanoid();
    this._activeStreamId = streamId;
    this._activeRequestId = requestId;
    this._segmentIndex = 0;
    this._isLive = true;

    this.sql`
      insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at)
      values (${streamId}, ${requestId}, 'streaming', ${Date.now()})
    `;

    return streamId;
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
              replay: true
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
          replay: true
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
          replay: true
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
        replayComplete: true
      })
    );
    return null;
  }

  replayCompletedChunksByRequestId(
    connection: Connection,
    requestId: string
  ): boolean {
    this.flushBuffer();

    const streams = this.sql<StreamMetadata>`
      select * from cf_ai_chat_stream_metadata
      where request_id = ${requestId}
      and status = 'completed'
      order by created_at desc
      limit 1
    `;
    const stream = streams[0];
    if (!stream) return false;

    const chunks = this.sql<StreamChunk>`
      select * from cf_ai_chat_stream_chunks
      where stream_id = ${stream.id}
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
              replay: true
            })
          )
        ) {
          return false;
        }
      }
    }

    return sendIfOpen(
      connection,
      JSON.stringify({
        body: "",
        done: true,
        id: requestId,
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        replay: true
      })
    );
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
  }

  // ── Internal ───────────────────────────────────────────────────────

  private _maybeCleanupOldStreams() {
    const now = Date.now();
    if (now - this._lastCleanupTime < CLEANUP_INTERVAL_MS) {
      return;
    }
    this._lastCleanupTime = now;

    const cutoff = now - CLEANUP_AGE_THRESHOLD_MS;
    this.sql`
      delete from cf_ai_chat_stream_chunks 
      where stream_id in (
        select id from cf_ai_chat_stream_metadata 
        where status in ('completed', 'error') and completed_at < ${cutoff}
      )
    `;
    this.sql`
      delete from cf_ai_chat_stream_metadata 
      where status in ('completed', 'error') and completed_at < ${cutoff}
    `;

    // Clean up abandoned "streaming" rows. These are orphaned streams that
    // were never completed or recovered (e.g. non-durable agents that never
    // reconnected). By this point, fiber recovery has already had its chance
    // to claim them — safe to delete.
    this.sql`
      delete from cf_ai_chat_stream_chunks
      where stream_id in (
        select id from cf_ai_chat_stream_metadata
        where status = 'streaming' and created_at < ${cutoff}
      )
    `;
    this.sql`
      delete from cf_ai_chat_stream_metadata
      where status = 'streaming' and created_at < ${cutoff}
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
}
