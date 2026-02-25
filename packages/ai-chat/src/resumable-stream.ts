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
import { MessageType } from "./types";

/** Number of chunks to buffer before flushing to SQLite */
const CHUNK_BUFFER_SIZE = 10;
/** Maximum buffer size to prevent memory issues on rapid reconnections */
const CHUNK_BUFFER_MAX_SIZE = 100;
/** Maximum age for a "streaming" stream before considering it stale (ms) - 5 minutes */
const STREAM_STALE_THRESHOLD_MS = 5 * 60 * 1000;
/** Default cleanup interval for old streams (ms) - every 10 minutes */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
/** Default age threshold for cleaning up completed streams (ms) - 24 hours */
const CLEANUP_AGE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
/** Shared encoder for UTF-8 byte length measurement */
const textEncoder = new TextEncoder();

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
  private _streamChunkIndex = 0;

  /**
   * Whether the active stream was started in this instance (true) or
   * restored from SQLite after hibernation/restart (false). An orphaned
   * stream has no live LLM reader — the ReadableStream was lost when the
   * DO was evicted.
   */
  private _isLive = false;

  private _chunkBuffer: Array<{
    id: string;
    streamId: string;
    body: string;
    index: number;
  }> = [];
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
    this._streamChunkIndex = 0;
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
    this._streamChunkIndex = 0;
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
    this._streamChunkIndex = 0;
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

    this._chunkBuffer.push({
      id: nanoid(),
      streamId,
      body,
      index: this._streamChunkIndex
    });
    this._streamChunkIndex++;

    // Flush when buffer reaches threshold
    if (this._chunkBuffer.length >= CHUNK_BUFFER_SIZE) {
      this.flushBuffer();
    }
  }

  /**
   * Flush buffered chunks to SQLite in a single batch.
   * Uses a lock to prevent concurrent flush operations.
   */
  flushBuffer() {
    if (this._isFlushingChunks || this._chunkBuffer.length === 0) {
      return;
    }

    this._isFlushingChunks = true;
    try {
      const chunks = this._chunkBuffer;
      this._chunkBuffer = [];

      const now = Date.now();
      for (const chunk of chunks) {
        this.sql`
          insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at)
          values (${chunk.id}, ${chunk.streamId}, ${chunk.body}, ${chunk.index}, ${now})
        `;
      }
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
      connection.send(
        JSON.stringify({
          body: chunk.body,
          done: false,
          id: requestId,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
          replay: true
        })
      );
    }

    if (this._activeStreamId !== streamId) {
      // Stream completed between our check above and now — send done.
      // In practice this cannot happen (DO is single-threaded and replay is
      // synchronous), but we guard defensively in case the flow changes.
      connection.send(
        JSON.stringify({
          body: "",
          done: true,
          id: requestId,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
          replay: true
        })
      );
      return null;
    }

    if (!this._isLive) {
      // Orphaned stream — restored from SQLite after hibernation but the
      // LLM ReadableStream reader was lost. No more live chunks will ever
      // arrive, so finalize it: send done and mark completed in SQLite.
      connection.send(
        JSON.stringify({
          body: "",
          done: true,
          id: requestId,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
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
    connection.send(
      JSON.stringify({
        body: "",
        done: false,
        id: requestId,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        replay: true,
        replayComplete: true
      })
    );
    return null;
  }

  // ── Restore / cleanup ──────────────────────────────────────────────

  /**
   * Restore active stream state if the agent was restarted during streaming.
   * Validates stream freshness to avoid sending stale resume notifications.
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
      const streamAge = Date.now() - stream.created_at;

      // Check if stream is stale; delete to free storage
      if (streamAge > STREAM_STALE_THRESHOLD_MS) {
        this
          .sql`delete from cf_ai_chat_stream_chunks where stream_id = ${stream.id}`;
        this
          .sql`delete from cf_ai_chat_stream_metadata where id = ${stream.id}`;
        console.warn(
          `[ResumableStream] Deleted stale stream ${stream.id} (age: ${Math.round(streamAge / 1000)}s)`
        );
        return;
      }

      this._activeStreamId = stream.id;
      this._activeRequestId = stream.request_id;

      // Get the last chunk index
      const lastChunk = this.sql<{ max_index: number }>`
        select max(chunk_index) as max_index 
        from cf_ai_chat_stream_chunks 
        where stream_id = ${this._activeStreamId}
      `;
      this._streamChunkIndex =
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
    this.sql`delete from cf_ai_chat_stream_chunks`;
    this.sql`delete from cf_ai_chat_stream_metadata`;
    this._activeStreamId = null;
    this._activeRequestId = null;
    this._streamChunkIndex = 0;
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
  }

  // ── Test helpers (matching old AIChatAgent test API) ────────────────

  /** @internal For testing only */
  getStreamChunks(
    streamId: string
  ): Array<{ body: string; chunk_index: number }> {
    return (
      this.sql<{ body: string; chunk_index: number }>`
        select body, chunk_index from cf_ai_chat_stream_chunks 
        where stream_id = ${streamId} 
        order by chunk_index asc
      ` || []
    );
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
