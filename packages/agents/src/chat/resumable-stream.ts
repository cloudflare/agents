/**
 * ResumableStream: chat's producer-side coalescing and wire-protocol replay
 * adapter over the `agents/streams` capability. Chat's in-flight output
 * lives in the shared durable chunk log (`cf_agents_streams` /
 * `cf_agents_stream_blocks`), one stream per turn, tagged with the turn's
 * request id so replay-by-request rides the capability's indexed lookup.
 *
 * Handles:
 * - Chunk buffering (Streams' batched appends: one block per 10 chunks)
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
import type { StreamRow } from "../streams/types";
import { sendReplayBodies, sendReplayControl } from "./replay-frames";
import {
  CHAT_LEGACY_COUNTER,
  CHAT_RETIRED_COUNTER,
  importLegacyChatProgress,
  importLegacyChatStreams
} from "./legacy-chat-streams";
import {
  latestChatRowByTag,
  parseChatMetadata,
  storedBodies,
  toPublicStatus,
  type PublicStreamStatus
} from "./stream-rows";
import {
  REPLAY_CHUNK_BYTES,
  REPLAY_ITEM_BYTES,
  utf8Length
} from "../internal/platform-limits";
import type { ChatTurnOutcome } from "./wire-types";

/**
 * When a turn's buffered chunks are written: every 10 chunks or 512 KB, in
 * one row write, into the stream's newest block while it stays under
 * 256 KB (a turn's stream is deleted whole, one row per block). Each chunk
 * keeps its own seq. A crash loses at most the 9 chunks still buffered, as
 * a packed segment did.
 */
const CHUNK_BATCH = { maxChunks: 10, maxBytes: 512_000, fillBlocks: true };
/**
 * Retention for abandoned `streaming` rows, measured from LAST chunk activity.
 *
 * An interrupted turn must have ample time to be resumed by a reconnecting
 * client or healed by task replay before its buffer is reaped. Only a stream
 * that has produced no chunk for this long is treated as truly dead. Last
 * activity is decided in two phases — a coarse cutoff on the stream row's
 * `updated_at` (stamped at open, not per append), then one indexed read of
 * the newest chunk's timestamp for rows past it — so a long but still-active
 * stream is never reclaimed mid-flight. Terminal rows carry no such window:
 * a stream that finished is redundant with its persisted message, and the
 * cutover deletes it in the same transaction; leftovers are reclaimed by
 * the next {@link ResumableStream.start}.
 */
const ABANDONED_STREAM_RETENTION_MS = 60 * 60 * 1000;

/**
 * Construct the Streams capability instance a chat host must install to back
 * its `ResumableStream`: identical to `new Streams()` except for the raised
 * per-chunk ceiling that chat's packed segments require.
 */
export function createChatStreams(): Streams {
  return new Streams({ maxChunkBytes: REPLAY_ITEM_BYTES });
}

/**
 * Chat's stream metadata, stored as the Streams row's metadata JSON. `cfChat`
 * marks rows this adapter owns — restore, retention, and clearAll never touch
 * a stream some other producer opened on the same Durable Object. The turn's
 * request id lives in the stream's indexed `tag`.
 */
export type ChatStreamMetadata = {
  cfChat: 1;
  /**
   * The assistant message id this stream is producing, captured when the
   * stream starts. This is the SAME id the live path persists under, so orphan
   * recovery (#1691) can re-associate reconstructed chunks with the correct
   * message even when the provider stream carries no `start.messageId`.
   */
  messageId?: string;
  /**
   * The message the stream's assistant message is a child of, when the turn
   * branches rather than appending to the latest leaf (a regeneration answers
   * its user message beside the response it replaces). Orphan recovery
   * appends under it so the reconstructed message lands on the same branch.
   */
  parentMessageId?: string;
  /**
   * Set when the stream extends an existing assistant message (`messageId`):
   * how many parts that message held when the stream started. The stream's
   * chunks hold only what came after, so orphan recovery replays them onto
   * that many leading parts of the stored message, which keeps the earlier
   * parts and makes recovering the same stream twice idempotent. Absent for a
   * stream that produces a message of its own.
   */
  basePartCount?: number;
  /**
   * Whether this stream is a continuation (appends to the last assistant
   * message rather than starting a new one). Live broadcast frames carry
   * `continuation: true`, and replay frames must too (#1733): without it a
   * reconnecting client treats a replayed continuation as a fresh message
   * and drops the parts streamed before the continuation.
   */
  isContinuation?: 1;
  /**
   * The `seq` of this stream's first chunk. A request that restarts its
   * stream (an overflow retry) continues its earlier streams' sequence, so a
   * client's per-request record of applied chunks never mistakes the new
   * stream's chunks for ones it already has (#1951).
   */
  seqBase?: number;
  /**
   * The user message ids the request originated from, echoed as `messageIds`
   * on the replayed terminal frame (#2280).
   */
  originMessageIds?: string[];
  /**
   * How the request ended, echoed as `outcome` on the replayed terminal
   * frame. Absent on rows written before it was recorded and on streams
   * that completed normally.
   */
  outcome?: ChatTurnOutcome;
  /**
   * Set when the stream was closed with no producer left: an isolate reset
   * cut the turn off, and a reconnecting tab's resume (or recovery itself)
   * closed the row. The row reads `completed`, but the model never finished
   * the reply, so recovery still continues the turn.
   */
  cutOff?: boolean;
  /**
   * Set on a stream whose chunks are stored one per seq (Streams' batched
   * appends). Absent on a stream from a version that stored packed
   * segments, one seq per up to 10 chunks: the recovery work meter counts
   * those seqs as they are.
   */
  perChunk?: 1;
};

/**
 * The recovery work units `seqs` stored seqs of a stream are: one per seq
 * for a stream of packed segments, one per 10 chunks (rounded up) for a
 * stream stored one chunk per seq, so a unit is what a segment held.
 */
function workUnits(chat: ChatStreamMetadata, seqs: number): number {
  return chat.perChunk === 1 ? Math.ceil(seqs / CHUNK_BATCH.maxChunks) : seqs;
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

/**
 * The deletion hook each adapter holds on its Streams capability. One
 * adapter per capability: a host whose startup retried constructs the
 * adapter again on the same capability, and the earlier hook must go, or a
 * deleted stream's segments would be retired once per construction.
 */
const deletionHooks = new WeakMap<Streams, () => void>();

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

  /**
   * Index the next stored chunk of the active stream gets, which is also its
   * position in a replay. `null` for a stream restored from SQLite, whose
   * count is not tracked.
   */
  private _nextChunkSeq: number | null = null;

  /** The stream with chunks waiting in Streams' buffer, if any. */
  private _bufferedStreamId: string | null = null;
  /**
   * A stream whose producer finished but whose row is deliberately still
   * `streaming`: the host will {@link cutover} it together with the message
   * write, or {@link finalizePending} it when there is nothing to persist.
   */
  private _pendingCutover: string | null = null;
  /** The stream most recently closed by complete, finish, or markError. */
  private _lastClosedStreamId: string | null = null;

  private readonly ops: StreamsSyncInternal;

  /** @internal The Streams sync aperture this adapter reads and writes. */
  get streamOps(): StreamsSyncInternal {
    return this.ops;
  }

  constructor(
    streams: Streams,
    sql: SqlTaggedTemplate,
    /** Whether this is a facet, which empties the legacy chat tables. */
    isFacet: () => boolean = () => false
  ) {
    this.ops = streams.__DO_NOT_USE_WILL_BREAK__sync();
    this.ops.ensureTables();
    importLegacyChatProgress(sql, this.ops, isFacet);
    // Every path that removes a chat row's log — this adapter's cutover,
    // reclaim and clear, and the capability's public `delete()` — folds the
    // row's segments into the retired total first. Registered before the
    // legacy migration, which is itself a delete path, and replacing the
    // hook of any adapter constructed earlier on this capability.
    deletionHooks.get(streams)?.();
    deletionHooks.set(
      streams,
      this.ops.onDelete((row, cursor) => {
        const chat = parseChatMetadata(row);
        if (!chat) return;
        this._retire(workUnits(chat, cursor));
      })
    );
    importLegacyChatStreams(sql, this.ops, isFacet);
    // Restore any active stream from a previous session
    this.restore();
  }

  // ── Recovery progress marker ───────────────────────────────────────
  //
  // Chat recovery's no-progress budget and work meter key off a monotonic
  // count of durably produced content (#1628, #1637). That count used to be
  // a Durable Object KV counter bumped on every credited chunk — a get and
  // a put per tool call and per text segment, on the streaming hot path.
  // The chunk log already IS the durable record of produced content, so the
  // marker is derived from it instead: segments still in the table are
  // counted from their logs, and a stream's segments are folded into a
  // retired total in the same transaction that deletes its rows, so the sum
  // never moves when rows go away. Nothing is written per chunk; one row is
  // written per stream retired.

  /**
   * Two counters kept with the Streams capability: `retired` accumulates
   * the segments of deleted streams and explicit credits; `legacy` holds
   * the pre-derivation KV counter, folded in once. They are separate so a
   * seed can never swallow segments retired before it landed, and a
   * repeated seed is idempotent.
   */
  private _retiredSegments(): number {
    return (
      this.ops.counter(CHAT_RETIRED_COUNTER) +
      this.ops.counter(CHAT_LEGACY_COUNTER)
    );
  }

  /** Add `segments` to the retired total. One row write; a no-op for zero. */
  private _retire(segments: number): void {
    if (segments <= 0) return;
    this.ops.addToCounter(CHAT_RETIRED_COUNTER, segments);
  }

  /**
   * Work units a row still accounts for, from a live stream's log tail or
   * a settled stream's final cursor (stamped exact at settlement).
   */
  private _segmentsOf(row: StreamRow & { chat: ChatStreamMetadata }): number {
    return workUnits(
      row.chat,
      row.state === "streaming"
        ? this.ops.cursor(row.stream_id)
        : row.chunk_count
    );
  }

  /**
   * Monotonic count of durably flushed chat segments on this Durable
   * Object, plus explicit credits (see {@link creditProgress}): the recovery
   * engine's forward-progress marker. Advances only when a segment lands in
   * the log — never on a reconnect replay or a recovery re-persist, which
   * read the log without appending — and is untouched by compaction, which
   * rewrites the transcript, not the log. Reads the stream rows plus one
   * log-tail row per live stream: called at incident evaluation, not on the
   * hot path.
   *
   * A chat row leaving the table by any path — this adapter's cutover,
   * reclaim and clear, or the capability's own `delete()` — passes through
   * the deletion hook, so its segments are retired before they are gone
   * and the marker never moves on a deletion.
   */
  progressMarker(): number {
    let live = 0;
    for (const row of this._chatRows()) live += this._segmentsOf(row);
    return this._retiredSegments() + live;
  }

  /**
   * Credit one unit of forward progress that the log cannot see: a parent
   * forwarding a sub-agent's output (N9) produces no chunks of its own, yet
   * that output is the parent turn advancing. One row write; callers
   * throttle.
   */
  creditProgress(): void {
    this._retire(1);
  }

  /**
   * Carry the KV counter forward: the marker must not read lower than the
   * high-water mark an in-flight incident already recorded, or a
   * progressing turn would look stuck until the log caught up. The counter
   * is either the pre-derivation one or the mirror of this marker's
   * durable part that earlier versions wrote (`retired + legacy`). Either way
   * it already counts every segment retired here, so the seed raises
   * `legacy` only to `counter - retired`: the marker then reads at least
   * the counter, and a mirrored value folds in as a no-op instead of adding
   * the retired history again on every isolate (#2702). Idempotent, and a
   * no-op for zero, so a fresh object never writes.
   *
   * The counter already credited a stream that was in flight at the
   * upgrade, and that stream's live segments count again here, so the
   * first read after the upgrade can exceed the counter by those segments.
   * That reads as progress once, and hands an in-flight incident one extra
   * no-progress window; it cannot recur.
   */
  seedProgress(legacyTotal: number): void {
    if (legacyTotal <= 0) return;
    const legacy = this.ops.counter(CHAT_LEGACY_COUNTER);
    const raised = Math.max(
      legacy,
      legacyTotal - this.ops.counter(CHAT_RETIRED_COUNTER)
    );
    if (raised !== legacy) this.ops.setCounter(CHAT_LEGACY_COUNTER, raised);
  }

  /**
   * Delete chat rows. The deletion hook folds each row's segments into the
   * retired total in the same synchronous block, retire before delete, so
   * a partial commit could only ever count a stream twice, never lose it.
   */
  private _deleteRetiring(rows: readonly StreamRow[]): void {
    if (rows.length === 0) return;
    this.ops.deleteMany(rows.map((row) => row.stream_id));
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
    options: {
      messageId?: string;
      parentMessageId?: string;
      basePartCount?: number;
      continuation?: boolean;
      originMessageIds?: string[];
    } = {}
  ): string {
    // Flush any pending chunks from previous streams to prevent mixing
    this.flushBuffer();
    // Before the reclaim below deletes the request's earlier stream.
    const seqBase = this._nextSeqForRequest(requestId);
    // Reclaim whatever a previous turn left behind: finished streams (their
    // messages are persisted, so the rows are dead weight) and in-flight
    // rows abandoned past the stale window. One row-table scan, no alarm.
    this.reclaim();

    const streamId = nanoid();
    this._activeStreamId = streamId;
    this._activeRequestId = requestId;
    this._isLive = true;
    this._activeIsContinuation = options.continuation ?? false;
    this._nextChunkSeq = seqBase;

    const metadata: ChatStreamMetadata = { cfChat: 1 };
    if (options.messageId != null) metadata.messageId = options.messageId;
    if (options.parentMessageId != null) {
      metadata.parentMessageId = options.parentMessageId;
    }
    if (options.basePartCount != null) {
      metadata.basePartCount = options.basePartCount;
    }
    if (this._activeIsContinuation) metadata.isContinuation = 1;
    if (seqBase > 0) metadata.seqBase = seqBase;
    metadata.perChunk = 1;
    if (options.originMessageIds?.length) {
      metadata.originMessageIds = options.originMessageIds;
    }
    this.ops.insertStream(streamId, requestId, metadata);

    return streamId;
  }

  private _nextSeqForRequest(requestId: string): number {
    const prior = latestChatRowByTag(this.ops, requestId);
    if (!prior) return 0;
    let count = 0;
    for (const _body of storedBodies(this.ops, prior.stream_id)) count++;
    return (parseChatMetadata(prior)?.seqBase ?? 0) + count;
  }

  private _seqBase(streamId: string): number {
    const row = this.ops.getStream(streamId);
    return (row && parseChatMetadata(row)?.seqBase) || 0;
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
   * How many parts the message an orphaned stream extends held when the
   * stream started, or null when the stream produces a message of its own.
   */
  getStreamBasePartCount(streamId: string): number | null {
    const row = this.ops.getStream(streamId);
    if (!row) return null;
    return parseChatMetadata(row)?.basePartCount ?? null;
  }

  /** Whether a stream was started for a continuation of an earlier turn. */
  getStreamIsContinuation(streamId: string): boolean {
    const row = this.ops.getStream(streamId);
    if (!row) return false;
    return parseChatMetadata(row)?.isContinuation === 1;
  }

  /**
   * The message an orphaned stream's assistant message is a child of, or null
   * when the stream appends to the latest leaf or predates parent tracking.
   */
  getStreamParentMessageId(streamId: string): string | null {
    const row = this.ops.getStream(streamId);
    if (!row) return null;
    return parseChatMetadata(row)?.parentMessageId ?? null;
  }

  /**
   * The user message ids the request's latest chat stream was started for
   * (#2280), or undefined when no stream recorded them. Once the stream's
   * rows are deleted, the request's recorded terminal frame carries them
   * (`recent-terminals.ts`).
   */
  getOriginMessageIds(requestId: string): string[] | undefined {
    const row = latestChatRowByTag(this.ops, requestId);
    return row ? parseChatMetadata(row)?.originMessageIds : undefined;
  }

  /**
   * How the request's latest chat stream ended (recorded by {@link complete}
   * or {@link finish}), or undefined for a normal completion. Once the
   * stream's rows are deleted, the request's recorded terminal frame carries
   * it.
   */
  getOutcome(requestId: string): ChatTurnOutcome | undefined {
    const row = latestChatRowByTag(this.ops, requestId);
    return row ? parseChatMetadata(row)?.outcome : undefined;
  }

  private _recordOutcome(
    streamId: string,
    outcome?: ChatTurnOutcome,
    cutOff = false
  ): void {
    if (!cutOff && (outcome === undefined || outcome === "completed")) return;
    const row = this.ops.getStream(streamId);
    const chat = row ? parseChatMetadata(row) : null;
    if (!chat) return;
    this.ops.setMetadata(streamId, {
      ...chat,
      ...(outcome !== undefined && outcome !== "completed" && { outcome }),
      ...(cutOff && { cutOff: true })
    });
  }

  /**
   * Mark a stream as completed and flush any pending chunks.
   * @param streamId - The stream to mark as completed
   * @param outcome - How the request ended, when not a normal completion.
   *   Defaults to `aborted` for a stream restored without a live reader.
   */
  complete(streamId: string, outcome?: ChatTurnOutcome) {
    this.flushBuffer();
    const orphaned = streamId === this._activeStreamId && !this._isLive;
    this._recordOutcome(
      streamId,
      outcome ?? (orphaned ? "aborted" : undefined),
      orphaned
    );
    this.ops.settle(streamId, "completed", null);
    if (this._pendingCutover === streamId) this._pendingCutover = null;
    this._lastClosedStreamId = streamId;
    this._clearActive();
  }

  /**
   * The producer finished, but leave the row `streaming` for the cutover:
   * the host persists the message and settles the stream in one
   * transaction with {@link cutover}. Until then a crash leaves the stream
   * live — exactly the evidence recovery rebuilds the message from. The
   * host MUST follow with {@link cutover} or {@link finalizePending}.
   */
  finish(streamId: string, outcome?: ChatTurnOutcome) {
    this.flushBuffer();
    this._recordOutcome(streamId, outcome);
    this._pendingCutover = streamId;
    this._lastClosedStreamId = streamId;
    this._clearActive();
  }

  /** The stream {@link finish}ed and awaiting its cutover, if any. */
  get pendingCutoverId(): string | null {
    return this._pendingCutover;
  }

  /**
   * The cutover: settle the stream, run `persist` (synchronous writes — the
   * message), and delete the stream's rows in one SQLite transaction. A
   * crash leaves either the live stream or the finished message, never
   * neither; nothing is left to sweep. `discard: false` keeps the settled
   * rows (an agent-tool child whose parent still tails them); they are
   * reclaimed by the next {@link start}. The settlement and `persist`
   * writes commit or roll back together.
   */
  cutover(
    streamId: string,
    persist: () => void,
    options: { discard?: boolean } = {}
  ): void {
    // No flush: the settle writes the buffered chunks, or drops them with
    // the rows it discards.
    if (this._bufferedStreamId === streamId) this._bufferedStreamId = null;
    const discard = options.discard ?? true;
    const commit = persist;
    // The discard deletes the rows inside the settle transaction, and the
    // deletion hook retires their segments there, so the marker moves with
    // the commit or not at all.
    const settled = this.ops.settle(streamId, "completed", null, {
      commit,
      discard
    });
    // The stream was settled (or deleted) by another path first, so the
    // settle was a no-op and `persist` did not run: the message must still
    // land, just not atomically with a settlement that already happened.
    if (!settled) commit();
    if (this._pendingCutover === streamId) this._pendingCutover = null;
    this._clearActive();
  }

  /**
   * Settle a {@link finish}ed stream that had nothing to persist (no parts,
   * a persist that threw). Idempotent; a no-op when nothing is pending.
   * The pending marker clears only once settlement succeeds, so a caller
   * may retry after a settlement failure — matching {@link cutover}.
   */
  finalizePending(): void {
    const streamId = this._pendingCutover;
    if (streamId === null) return;
    this.ops.settle(streamId, "completed", null);
    this._pendingCutover = null;
  }

  private _clearActive() {
    this._activeStreamId = null;
    this._activeRequestId = null;
    this._isLive = false;
    this._activeIsContinuation = false;
  }

  /**
   * Mark a stream as errored and clean up state.
   * @param streamId - The stream to mark as errored
   */
  markError(streamId: string): void {
    this.flushBuffer();
    this.ops.settle(streamId, "errored", null);
    if (this._pendingCutover === streamId) this._pendingCutover = null;
    this._lastClosedStreamId = streamId;
    this._clearActive();
  }

  // ── Chunk storage ──────────────────────────────────────────────────

  /**
   * Buffer a stream chunk for batch write to storage.
   * Chunks exceeding the row size limit are skipped to prevent crashes.
   * The chunk is still broadcast to live clients (caller handles that),
   * but will be missing from replay on reconnection.
   * @param streamId - The stream this chunk belongs to
   * @param body - The serialized chunk body
   * @returns The chunk's index in a replay of the stream, for the live
   *   broadcast to carry as `seq`; `undefined` when the chunk is not stored
   *   or the stream's count is not tracked.
   */
  storeChunk(streamId: string, body: string): number | undefined {
    // Guard against chunks that would exceed the SQLite row limit, measured
    // on the stored (JSON-escaped) encoding. The chunk is still broadcast to
    // live clients; only replay storage is skipped.
    const json = JSON.stringify(body);
    const bodyBytes = utf8Length(json);
    if (bodyBytes > REPLAY_CHUNK_BYTES) {
      console.warn(
        `[ResumableStream] Skipping oversized chunk (${bodyBytes} bytes) ` +
          `to prevent SQLite row limit crash. Live clients still receive it.`
      );
      return undefined;
    }
    const seq =
      streamId === this._activeStreamId && this._nextChunkSeq !== null
        ? this._nextChunkSeq++
        : undefined;
    // One stream buffers at a time: start() flushes before switching.
    if (this._bufferedStreamId !== streamId) this.flushBuffer();
    try {
      this.ops.appendJson(streamId, json, bodyBytes, CHUNK_BATCH);
      this._bufferedStreamId = streamId;
    } catch {
      // The stream settled or was deleted (a late writer after markError or
      // cleanup), or its write failed; the chunk is dropped from replay.
    }
    return seq;
  }

  /**
   * Write the buffered chunks now, as one block (one INSERT). A write that
   * fails drops them, as a crash would.
   */
  flushBuffer() {
    const streamId = this._bufferedStreamId;
    if (streamId === null) return;
    this._bufferedStreamId = null;
    try {
      this.ops.flush(streamId);
    } catch {
      // The write failed; the buffered chunks are dropped.
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
        storedBodies(this.ops, streamId),
        continuation,
        this._seqBase(streamId),
        this.getStreamMessageId(streamId) ?? undefined
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
      const row = this.ops.getStream(streamId);
      sendReplayControl(connection, requestId, {
        done: true,
        continuation,
        messageIds: row ? parseChatMetadata(row)?.originMessageIds : undefined,
        outcome: "aborted"
      });
      this.complete(streamId, "aborted");
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
   * Replay the request's just-closed stream (finished and awaiting its
   * cutover, completed for a recovery, or errored), ending in
   * `replayComplete` rather than `done`: the host has not sent the request's
   * terminal frame yet and delivers it live once the message is persisted.
   * After the cutover deleted the rows, only the `replayComplete` is sent.
   * @returns False when the connection closed mid-replay.
   */
  replayClosedStreamChunks(connection: Connection, requestId: string): boolean {
    this.flushBuffer();
    const row =
      this._lastClosedStreamId !== null
        ? this.ops.getStream(this._lastClosedStreamId)
        : undefined;
    const chat = row?.tag === requestId ? parseChatMetadata(row) : null;
    const continuation = chat?.isContinuation === 1;
    if (
      row &&
      chat &&
      !sendReplayBodies(
        connection,
        requestId,
        storedBodies(this.ops, row.stream_id),
        continuation,
        chat.seqBase,
        chat.messageId
      )
    ) {
      return false;
    }
    return sendReplayControl(connection, requestId, {
      done: false,
      replayComplete: true,
      continuation
    });
  }

  /**
   * Latest chat stream row for a request regardless of status — the recovery
   * engines' stream-evidence lookup.
   */
  latestStreamInfoForRequest(requestId: string): {
    id: string;
    status: PublicStreamStatus;
    createdAt: number;
    /**
     * The stream was closed with no producer left (see
     * {@link ChatStreamMetadata.cutOff}). Its `completed` status says the
     * row is closed, not that the reply finished.
     */
    cutOff: boolean;
  } | null {
    const row = latestChatRowByTag(this.ops, requestId);
    if (!row) return null;
    return {
      id: row.stream_id,
      status: toPublicStatus(row.state),
      createdAt: row.created_at,
      cutOff: parseChatMetadata(row)?.cutOff === true
    };
  }

  /**
   * Latest in-flight chat stream for a request — recoverable-turn evidence.
   */
  latestActiveStreamInfoForRequest(
    requestId: string
  ): { id: string; createdAt: number } | null {
    const row = latestChatRowByTag(this.ops, requestId, "streaming");
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
      this._nextChunkSeq = null;
    }
  }

  /**
   * Clear all chat stream data (called on chat history clear). Streams other
   * producers opened on the same Durable Object are untouched.
   */
  clearAll() {
    this._bufferedStreamId = null;
    this._deleteRetiring(this._chatRows());
    this._lastClosedStreamId = null;
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
   * Delete every chat stream row this Durable Object no longer needs:
   * finished streams (their messages are persisted; the cutover normally
   * deletes them in the same transaction, so these are crash leftovers) and
   * in-flight rows abandoned past {@link ABANDONED_STREAM_RETENTION_MS} by
   * last chunk activity. Runs on every {@link start}, so nothing needs an
   * alarm to be reclaimed; a Durable Object that never starts another turn
   * keeps at most one turn's rows. Streams other producers opened on the
   * same object are untouched.
   * @returns How many rows were reclaimed.
   */
  reclaim(now: number = Date.now()): number {
    const abandonedCutoff = now - ABANDONED_STREAM_RETENTION_MS;
    const reclaimable = this._chatRows().filter((row) =>
      row.state === "streaming"
        ? row.stream_id !== this._activeStreamId &&
          row.updated_at < abandonedCutoff &&
          (this.ops.lastChunkAt(row.stream_id) ?? row.updated_at) <
            abandonedCutoff
        : true
    );
    this._deleteRetiring(reclaimable);
    return reclaimable.length;
  }

  // ── Internal ───────────────────────────────────────────────────────

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
    return [...this.storedChunks(streamId)];
  }

  /**
   * The same chunks as {@link getStreamChunks}, read one page of segments at
   * a time, so a reader that stops early decodes no more than it took.
   */
  *storedChunks(
    streamId: string
  ): Generator<{ body: string; chunk_index: number }> {
    let chunk_index = 0;
    for (const body of storedBodies(this.ops, streamId)) {
      yield { body, chunk_index: chunk_index++ };
    }
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
}
