/**
 * ResumableStream: chat's producer-side coalescing and wire-protocol replay
 * adapter over the `agents/streams` capability. Chat's in-flight output
 * lives in the shared durable chunk log (`cf_agents_streams` /
 * `cf_agents_stream_blocks`), one stream per turn, tagged with the turn's
 * request id so replay-by-request rides the capability's indexed lookup.
 *
 * Handles:
 * - Chunk buffering (packed segments — batched writes for storage-op economy)
 * - Stream lifecycle (start, complete, error) mapped onto Streams settlement
 * - Chunk replay for reconnecting clients (framing in `replay-frames.ts`)
 * - Stale stream cleanup (row-level retention; at most one indexed
 *   chunk-tail read per stale live candidate, never a chunk-table scan)
 * - Active stream restoration after agent restart
 * - One-time migration of legacy `cf_ai_chat_stream_*` tables
 *
 * The adapter's public surface is synchronous and may be constructed before
 * the Lifecycle starts, so it runs on the Streams internal sync aperture; the
 * invariant-bearing writes (append fence, settlement, wakeups, events) go
 * through the capability, so live `streams.read()` consumers and diagnostics
 * observe chat streams like any other stream. The host `sql` handle is used
 * only for chat's own legacy tables during migration.
 */

import { nanoid } from "nanoid";
import type { Connection } from "agents";
import { Streams, type StreamsSyncInternal } from "../streams/streams";
import type { StreamJson, StreamRow, StreamState } from "../streams/types";
import { sendReplayBodies, sendReplayControl } from "./replay-frames";

/** Number of chunks to pack into a single stored segment before flushing */
const CHUNK_BUFFER_SIZE = 10;
/** Maximum buffer size to prevent memory issues on rapid reconnections */
const CHUNK_BUFFER_MAX_SIZE = 100;
/**
 * Max accumulated raw chunk bytes packed into one segment before forcing a
 * flush. The SQLite row limit is 2 MB; packing serializes bodies into a JSON
 * array, which re-escapes their contents (quotes/backslashes), so we keep the
 * raw total well under the limit to leave generous headroom for escaping
 * overhead. A chunk larger than this is flushed as its own (unwrapped)
 * segment.
 */
const SEGMENT_MAX_BYTES = 512_000;
/**
 * Stored segments per page when replaying a stream's chunk log. Bounds
 * replay memory to one page of segment bodies rather than the whole turn.
 */
const REPLAY_PAGE_SEGMENTS = 10;
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
 * have ample time to be resumed by a reconnecting client or healed by task
 * replay before its buffer is reaped. Only a stream that has produced no
 * chunk for this long is treated as truly dead. Last activity is decided in
 * two phases — a coarse cutoff on the stream row's `updated_at` (stamped at
 * open, not per append), then one indexed read of the newest chunk's
 * timestamp for rows past it — so a long but still-active stream is never
 * swept mid-flight.
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
 * Ceiling for one stored chat segment after JSON serialization, and the
 * `maxChunkBytes` the backing Streams capability must be constructed with.
 * Kept under the 2 MB SQLite row limit with headroom for escaping.
 */
const CHAT_STREAM_MAX_CHUNK_BYTES = 1_900_000;

/** Maximum serialized chunk body size before skipping storage (bytes). */
const CHUNK_MAX_BYTES = 1_800_000;

/**
 * Construct the Streams capability instance a chat host must install to back
 * its `ResumableStream`: identical to `new Streams()` except for the raised
 * per-chunk ceiling that chat's packed segments require.
 */
export function createChatStreams(): Streams {
  return new Streams({ maxChunkBytes: CHAT_STREAM_MAX_CHUNK_BYTES });
}

/**
 * Chat's stream metadata, stored as the Streams row's metadata JSON. `cfChat`
 * marks rows this adapter owns — restore, retention, and clearAll never touch
 * a stream some other producer opened on the same Durable Object. The turn's
 * request id lives in the stream's indexed `tag`.
 */
type ChatStreamMetadata = {
  cfChat: 1;
  /**
   * The assistant message id this stream is producing, captured when the
   * stream starts. This is the SAME id the live path persists under, so orphan
   * recovery (#1691) can re-associate reconstructed chunks with the correct
   * message even when the provider stream carries no `start.messageId`.
   */
  messageId?: string;
  /**
   * Whether this stream is a continuation (appends to the last assistant
   * message rather than starting a new one). Live broadcast frames carry
   * `continuation: true`, and replay frames must too (#1733): without it a
   * reconnecting client treats a replayed continuation as a fresh message
   * and drops the parts streamed before the continuation.
   */
  isContinuation?: 1;
};

/** Public status vocabulary predates the Streams state names. */
type PublicStreamStatus = "streaming" | "completed" | "error";

function toPublicStatus(state: StreamRow["state"]): PublicStreamStatus {
  return state === "errored" ? "error" : state;
}

function parseChatMetadata(row: StreamRow): ChatStreamMetadata | null {
  if (row.metadata === null) return null;
  try {
    const parsed = JSON.parse(row.metadata) as Partial<ChatStreamMetadata>;
    if (parsed && parsed.cfChat === 1) return parsed as ChatStreamMetadata;
  } catch {
    // Not chat metadata.
  }
  return null;
}

/**
 * A stored segment is either a single chunk body (a JSON string value) or a
 * packed segment (a JSON array of chunk body strings). Unpack to the
 * individual chunk bodies in order.
 */
function unpackSegment(rawChunkJson: string): string[] {
  const parsed = JSON.parse(rawChunkJson) as StreamJson;
  if (Array.isArray(parsed)) return parsed as string[];
  return [parsed as string];
}

/**
 * Minimal SQL interface matching Agent's this.sql tagged template. The
 * adapter uses it exclusively for chat's own legacy tables during migration.
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
  /**
   * Whether the active stream was started in this instance (true) or
   * restored from SQLite after hibernation/restart (false). An orphaned
   * stream has no live LLM reader — the ReadableStream was lost when the
   * DO was evicted.
   */
  private _isLive = false;

  /**
   * Whether the active stream is a continuation. Mirrors the durable
   * metadata so replay frames can carry the flag without a per-replay query;
   * restored from SQLite after hibernation in restore().
   */
  private _activeIsContinuation = false;

  private _chunkBuffer: Array<{ streamId: string; body: string }> = [];
  private _chunkBufferBytes = 0;
  private _isFlushingChunks = false;
  private _lastCleanupTime = 0;

  private readonly ops: StreamsSyncInternal;

  constructor(streams: Streams, sql: SqlTaggedTemplate) {
    this.ops = streams.__DO_NOT_USE_WILL_BREAK__sync();
    this.ops.ensureTables();
    this._migrateLegacyTables(sql);
    // Restore any active stream from a previous session
    this.restore();
  }

  /**
   * One-time migration of the pre-capability `cf_ai_chat_stream_*` tables
   * into the Streams tables, preserving in-flight resumability across the
   * upgrade (an active stream keeps its id, chunks, and last-activity), then
   * dropping the legacy tables. Tolerates the pre-#1691/#1733 metadata
   * schema (no `message_id` / `is_continuation` columns). The host `sql`
   * handle touches only these chat-owned legacy tables.
   */
  private _migrateLegacyTables(sql: SqlTaggedTemplate): void {
    const legacyTables = sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('cf_ai_chat_stream_metadata', 'cf_ai_chat_stream_chunks')
    `.map((row) => row.name);
    if (legacyTables.length === 0) return;

    if (legacyTables.includes("cf_ai_chat_stream_metadata")) {
      const columns = sql<{ name: string }>`
        SELECT name FROM pragma_table_info('cf_ai_chat_stream_metadata')
      `.map((row) => row.name);
      const hasMessageId = columns.includes("message_id");
      const hasContinuation = columns.includes("is_continuation");
      const hasChunks = legacyTables.includes("cf_ai_chat_stream_chunks");

      const rows = sql<{
        id: string;
        request_id: string;
        status: string;
        created_at: number;
        completed_at: number | null;
        message_id?: string | null;
        is_continuation?: number | null;
      }>`SELECT * FROM cf_ai_chat_stream_metadata`;
      for (const row of rows) {
        const streamId = String(row.id);
        if (this.ops.getStream(streamId)) continue;

        const metadata: ChatStreamMetadata = { cfChat: 1 };
        if (hasMessageId && row.message_id != null) {
          metadata.messageId = String(row.message_id);
        }
        if (hasContinuation && row.is_continuation === 1) {
          metadata.isContinuation = 1;
        }

        const chunkRows = hasChunks
          ? sql<{ body: string; created_at: number }>`
              SELECT body, created_at FROM cf_ai_chat_stream_chunks
              WHERE stream_id = ${streamId} ORDER BY chunk_index ASC
            `
          : [];

        const status = String(row.status);
        const state: StreamState =
          status === "error"
            ? "errored"
            : status === "completed"
              ? "completed"
              : "streaming";
        const createdAt = Number(row.created_at);
        const closedAt =
          row.completed_at != null ? Number(row.completed_at) : null;
        // Preserve last-activity semantics: the legacy sweep keyed off the
        // newest chunk write, falling back to the stream's start time.
        const lastChunkAt = chunkRows.reduce(
          (max, chunk) => Math.max(max, Number(chunk.created_at)),
          createdAt
        );

        // The row is imported complete: final chunk count and last-activity
        // timestamp up front, because importChunk is a bare log INSERT that
        // never touches the stream row. A terminal row must carry its exact
        // cursor at rest (nothing stamps it later), and a live row's
        // updated_at seeds the sweep's coarse cutoff until real appends
        // resume.
        this.ops.importStream({
          streamId,
          state,
          tag: String(row.request_id),
          metadata,
          chunkCount: chunkRows.length,
          createdAt,
          updatedAt: closedAt ?? lastChunkAt,
          closedAt
        });
        for (const chunk of chunkRows) {
          const body = String(chunk.body);
          // A legacy row body is either a packed JSON array of chunk bodies
          // (imported verbatim as that array) or a single opaque body string.
          let value: StreamJson = body;
          try {
            const parsed = JSON.parse(body) as StreamJson;
            if (Array.isArray(parsed)) value = parsed;
          } catch {
            // Opaque body string.
          }
          this.ops.importChunk(streamId, value, Number(chunk.created_at));
        }
      }
    }

    sql`DROP TABLE IF EXISTS cf_ai_chat_stream_chunks`;
    sql`DROP TABLE IF EXISTS cf_ai_chat_stream_metadata`;
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
   * Creates the backing stream row and sets up tracking state.
   * @param requestId - The unique ID of the chat request
   * @returns The generated stream ID
   */
  start(
    requestId: string,
    options: { messageId?: string; continuation?: boolean } = {}
  ): string {
    // Flush any pending chunks from previous streams to prevent mixing
    this.flushBuffer();
    // Reclaim completed streams a previous turn left behind (a crash
    // between persist and discard): their messages are persisted, so the
    // rows are dead weight. One row-table scan, no alarm.
    for (const row of this._chatRows()) {
      if (row.state === "completed") this.ops.deleteUnchecked(row.stream_id);
    }

    const streamId = nanoid();
    this._activeStreamId = streamId;
    this._activeRequestId = requestId;
    this._isLive = true;
    this._activeIsContinuation = options.continuation ?? false;

    const metadata: ChatStreamMetadata = { cfChat: 1 };
    if (options.messageId != null) metadata.messageId = options.messageId;
    if (this._activeIsContinuation) metadata.isContinuation = 1;
    this.ops.insertStream(streamId, requestId, metadata);

    return streamId;
  }

  /**
   * The assistant message id an orphaned stream was producing — the same id the
   * live path persists under, so recovery re-associates reconstructed chunks
   * with the correct message (#1691). Returns null when the row is missing or
   * predates message-id tracking.
   */
  getStreamMessageId(streamId: string): string | null {
    const row = this.ops.getStream(streamId);
    if (!row) return null;
    return parseChatMetadata(row)?.messageId ?? null;
  }

  /**
   * Mark a stream as completed and flush any pending chunks.
   *
   * With `persist`, this is the cutover: the settle, the caller's message
   * write and the discard of the stream's rows commit in one SQLite
   * transaction, so a crash leaves either the live stream or the finished
   * message, never neither, and nothing is left for a sweep. `persist`
   * must be synchronous.
   * @param streamId - The stream to mark as completed
   */
  complete(streamId: string, options: { persist?: () => void } = {}) {
    this.flushBuffer();

    if (options.persist) {
      this.ops.settle(streamId, "completed", null, {
        commit: options.persist,
        discard: true
      });
    } else {
      this.ops.settle(streamId, "completed", null);
    }
    this._activeStreamId = null;
    this._activeRequestId = null;
    this._isLive = false;
    this._activeIsContinuation = false;

    // Periodically clean up old streams
    this._maybeCleanupOldStreams();
  }

  /**
   * Drop a completed stream's rows once its message is persisted. The rows
   * are redundant with the message from that moment, so deleting them here
   * (a handful of block rows) is what keeps the retention sweep from ever
   * finding completed streams. Live and errored streams are left alone:
   * a live one may still be resumed, an errored one still owes a resumed
   * client its terminal frame (#1645).
   * @returns Whether rows were deleted.
   */
  discardCompleted(streamId: string): boolean {
    const row = this.ops.getStream(streamId);
    if (!row || row.state !== "completed") return false;
    this.ops.deleteUnchecked(streamId);
    return true;
  }

  /**
   * Mark a stream as errored and clean up state.
   * @param streamId - The stream to mark as errored
   */
  markError(streamId: string) {
    this.flushBuffer();

    this.ops.settle(streamId, "errored", null);
    this._activeStreamId = null;
    this._activeRequestId = null;
    this._isLive = false;
    this._activeIsContinuation = false;
  }

  // ── Chunk storage ──────────────────────────────────────────────────

  /**
   * Buffer a stream chunk for batch write to storage.
   * Chunks exceeding the row size limit are skipped to prevent crashes.
   * The chunk is still broadcast to live clients (caller handles that),
   * but will be missing from replay on reconnection.
   * @param streamId - The stream this chunk belongs to
   * @param body - The serialized chunk body
   */
  storeChunk(streamId: string, body: string) {
    // Guard against chunks that would exceed the SQLite row limit, measured
    // on the stored (JSON-escaped) encoding. The chunk is still broadcast to
    // live clients; only replay storage is skipped.
    const bodyBytes = textEncoder.encode(JSON.stringify(body)).byteLength;
    if (bodyBytes > CHUNK_MAX_BYTES) {
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
   * Flush the buffered chunks to storage as a single packed segment.
   * Uses a lock to prevent concurrent flush operations.
   *
   * The whole buffer becomes one stored chunk on the backing stream: a
   * single-chunk segment is stored unwrapped so a large chunk avoids
   * array-escaping inflation, while a multi-chunk segment stores a JSON
   * array of bodies. This collapses N chunk writes into one fenced append,
   * cutting rows written / stored / scanned.
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
      const segment: StreamJson =
        chunks.length === 1
          ? chunks[0].body
          : chunks.map((chunk) => chunk.body);

      try {
        this.ops.append(streamId, segment);
      } catch {
        // The stream settled or was deleted while chunks were buffered (a
        // late writer after markError/cleanup); the chunks are dropped.
      }
    } finally {
      this._isFlushingChunks = false;
    }
  }

  // ── Chunk replay ───────────────────────────────────────────────────

  /**
   * Stored chunk bodies for one stream, packed segments expanded, in order.
   * A generator over paged reads, so replaying a large turn holds one page
   * of segments in memory instead of the whole stored stream; iteration is
   * synchronous end to end (WebSocket sends don't await), so the pages see
   * a consistent log.
   */
  private *_storedBodies(streamId: string): Generator<string> {
    let next = 0;
    for (;;) {
      const rows = this.ops.readChunks(streamId, next, REPLAY_PAGE_SEGMENTS);
      for (const row of rows) {
        next = row.seq + 1;
        yield* unpackSegment(row.chunk);
      }
      if (rows.length < REPLAY_PAGE_SEGMENTS) return;
    }
  }

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
   *
   * All sends tolerate a WebSocket closing mid-replay. If the connection
   * drops while iterating chunks the stream is left active so the next
   * reconnect can retry.
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
    const continuation = this._activeIsContinuation;

    if (
      !sendReplayBodies(
        connection,
        requestId,
        this._storedBodies(streamId),
        continuation
      )
    ) {
      // Connection closed mid-replay — leave the stream active so the
      // next reconnect can retry from the start.
      return null;
    }

    if (!this._isLive) {
      // Orphaned stream — restored from SQLite after hibernation but the
      // LLM ReadableStream reader was lost. No more live chunks will ever
      // arrive, so finalize it: best-effort send done, then mark completed.
      // The orphan-cleanup decision is committed regardless of whether this
      // particular connection received the done frame, so the caller can
      // persist the reconstructed message.
      sendReplayControl(connection, requestId, { done: true, continuation });
      this.complete(streamId);
      return streamId;
    }

    // Stream is still active with a live reader — signal that replay is
    // complete so the client can flush accumulated parts to React state.
    // Without this, replayed chunks sit in activeStreamRef unflushed
    // until the next live chunk arrives.
    sendReplayControl(connection, requestId, {
      done: false,
      replayComplete: true,
      continuation
    });
    return null;
  }

  /**
   * Latest CHAT-owned row carrying a request tag. The stream table is
   * shared with application producers and tags are non-unique, so the
   * newest row by tag alone could be an unrelated stream masking chat's
   * recovery evidence — ownership is the `cfChat` metadata marker.
   */
  private _latestChatRowByTag(
    requestId: string,
    state?: StreamRow["state"]
  ): StreamRow | undefined {
    return this.ops
      .rowsByTag(requestId, state)
      .find((row) => parseChatMetadata(row) !== null);
  }

  replayCompletedChunksByRequestId(
    connection: Connection,
    requestId: string
  ): boolean {
    this.flushBuffer();
    const row = this._latestChatRowByTag(requestId, "completed");
    if (!row) return false;

    const continuation = parseChatMetadata(row)?.isContinuation === 1;
    if (
      !sendReplayBodies(
        connection,
        requestId,
        this._storedBodies(row.stream_id),
        continuation
      )
    ) {
      return false;
    }
    return sendReplayControl(connection, requestId, {
      done: true,
      continuation
    });
  }

  /**
   * Replay the stored chunks of an errored stream for a request, WITHOUT a
   * terminal frame — the caller follows up with the `done: true, error: true`
   * frame carrying the durable terminal record's error text, mirroring what a
   * live client observed (content chunks, then the error). Without this, a
   * client that missed broadcast frames while disconnected has no other
   * channel to the pre-error partial content (#1575).
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
    this.flushBuffer();
    const row = this._latestChatRowByTag(requestId, "errored");
    if (!row) return true;
    return sendReplayBodies(
      connection,
      requestId,
      this._storedBodies(row.stream_id),
      parseChatMetadata(row)?.isContinuation === 1
    );
  }

  /**
   * Latest chat stream row for a request regardless of status — the recovery
   * engines' stream-evidence lookup.
   */
  latestStreamInfoForRequest(
    requestId: string
  ): { id: string; status: PublicStreamStatus; createdAt: number } | null {
    const row = this._latestChatRowByTag(requestId);
    if (!row) return null;
    return {
      id: row.stream_id,
      status: toPublicStatus(row.state),
      createdAt: row.created_at
    };
  }

  /**
   * Latest in-flight chat stream for a request — recoverable-turn evidence.
   */
  latestActiveStreamInfoForRequest(
    requestId: string
  ): { id: string; createdAt: number } | null {
    const row = this._latestChatRowByTag(requestId, "streaming");
    if (!row) return null;
    return { id: row.stream_id, createdAt: row.created_at };
  }

  // ── Restore / cleanup ──────────────────────────────────────────────

  /** Every chat-owned stream row, newest first. */
  private _chatRows(): Array<StreamRow & { chat: ChatStreamMetadata }> {
    const rows: Array<StreamRow & { chat: ChatStreamMetadata }> = [];
    for (const row of this.ops.listRows()) {
      const chat = parseChatMetadata(row);
      if (chat) rows.push({ ...row, chat });
    }
    return rows;
  }

  /**
   * Restore active stream state if the agent was restarted during streaming.
   * All streams are restored regardless of age — stale cleanup happens
   * lazily in _maybeCleanupOldStreams after recovery has had its chance.
   */
  restore() {
    const row = this._chatRows().find((r) => r.state === "streaming");
    if (row) {
      this._activeStreamId = row.stream_id;
      this._activeRequestId = row.tag;
      // Rehydrate the continuation flag so an orphaned continuation stream
      // replayed after hibernation still carries `continuation: true` on
      // its frames (#1733).
      this._activeIsContinuation = row.chat.isContinuation === 1;
    }
  }

  /**
   * Clear all chat stream data (called on chat history clear). Streams other
   * producers opened on the same Durable Object are untouched.
   */
  clearAll() {
    this._chunkBuffer = [];
    this._chunkBufferBytes = 0;
    this.ops.deleteMany(this._chatRows().map((row) => row.stream_id));
    this._activeStreamId = null;
    this._activeRequestId = null;
    this._activeIsContinuation = false;
  }

  /**
   * Remove all chat stream data (called on destroy). The backing tables
   * belong to the Streams capability and are shared with other producers,
   * so this deletes chat's rows rather than dropping tables. Buffered
   * chunks are dropped (clearAll resets the buffer), not flushed: they
   * belong to a chat-owned stream this very call deletes, so writing them
   * first would only pay row writes for rows that die in the same
   * synchronous block.
   */
  destroy() {
    this.clearAll();
  }

  /**
   * Force a sweep of aged stream buffers now, bypassing the lazy interval
   * gate used by {@link _maybeCleanupOldStreams}. Intended to be driven by an
   * alarm so idle/hibernated chat DOs still reclaim buffers even when no
   * further stream ever completes to trigger the lazy path.
   *
   * @returns How many chat stream rows survive the sweep — the re-arm
   * signal, so the alarm body needs no second scan of the table.
   */
  cleanup(now: number = Date.now()): number {
    this._lastCleanupTime = now;
    return this._sweepOldStreams(now);
  }

  /**
   * True if any chat stream rows remain at all. Used by alarm-driven cleanup
   * to decide whether to re-arm: once no rows remain there is nothing left to
   * sweep, so the DO can stop waking itself.
   */
  hasReclaimableStreams(): boolean {
    return this._chatRows().length > 0;
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
   *  must outlive resume/replay before it is presumed dead. Abandonment is
   *  decided in two phases: the stream row's `updated_at` (stamped at open,
   *  not per append — appends write only the chunk log) is the coarse
   *  cutoff, and only rows past it pay one indexed read of the newest
   *  chunk's timestamp to confirm the producer really stopped. An actively
   *  appending stream is never swept, and a quiet sweep still reads no
   *  chunk rows at all.
   *  @returns How many chat stream rows survive the sweep. */
  private _sweepOldStreams(now: number): number {
    const completedCutoff = now - COMPLETED_RETENTION_MS;
    const abandonedCutoff = now - ABANDONED_STREAM_RETENTION_MS;
    const rows = this._chatRows();
    const reclaimable = rows
      .filter((row) =>
        row.state === "streaming"
          ? row.updated_at < abandonedCutoff &&
            (this.ops.lastChunkAt(row.stream_id) ?? row.updated_at) <
              abandonedCutoff
          : (row.closed_at ?? row.updated_at) < completedCutoff
      )
      .map((row) => row.stream_id);
    this.ops.deleteMany(reclaimable);
    return rows.length - reclaimable.length;
  }

  // ── Test helpers (matching old AIChatAgent test API) ────────────────

  /**
   * Return the stored chunks for a stream as individual chunk bodies in order,
   * unpacking packed segments. The returned `chunk_index` is a running
   * per-chunk sequence (0, 1, 2, …) — stable across calls because segments
   * are append-only — so callers can use it as a monotonic chunk sequence.
   */
  getStreamChunks(
    streamId: string
  ): Array<{ body: string; chunk_index: number }> {
    return [...this._storedBodies(streamId)].map((body, chunk_index) => ({
      body,
      chunk_index
    }));
  }

  /** @internal For testing only */
  getStreamMetadata(
    streamId: string
  ): { status: string; request_id: string } | null {
    const row = this.ops.getStream(streamId);
    if (!row || !parseChatMetadata(row)) return null;
    return {
      status: toPublicStatus(row.state),
      request_id: row.tag ?? ""
    };
  }

  /** @internal For testing only */
  getAllStreamMetadata(): Array<{
    id: string;
    status: string;
    request_id: string;
    created_at: number;
    message_id: string | null;
  }> {
    return this._chatRows().map((row) => ({
      id: row.stream_id,
      status: toPublicStatus(row.state),
      request_id: row.tag ?? "",
      created_at: row.created_at,
      message_id: row.chat.messageId ?? null
    }));
  }

  /** @internal For testing only */
  insertStaleStream(streamId: string, requestId: string, ageMs: number): void {
    const createdAt = Date.now() - ageMs;
    this.ops.importStream({
      streamId,
      state: "streaming",
      tag: requestId,
      metadata: { cfChat: 1 },
      chunkCount: 0,
      createdAt,
      updatedAt: createdAt,
      closedAt: null
    });
  }

  /**
   * Append a chunk to a stream dated `ageMs` in the past. Used to exercise
   * the sweep's phase-2 verification: a long-running streaming row with a
   * *recent* chunk must survive even when its row `updated_at` (stamped at
   * open, not per append) is older than the coarse cutoff.
   * @internal For testing only
   */
  insertChunkAt(streamId: string, body: string, ageMs: number): void {
    this.ops.importChunk(streamId, body, Date.now() - ageMs);
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
  stream: Pick<ResumableStream, "cleanup">,
  rearm: () => Promise<void>
): Promise<void> {
  if (stream.cleanup() > 0) {
    await rearm();
  }
}
