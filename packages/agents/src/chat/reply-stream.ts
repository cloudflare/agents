/**
 * The resumable stream a chat reply writes, as both chat hosts use it.
 *
 * `ResumableStream` stores the chunks. This class adds what each host did
 * around every call: a started stream releases the tabs parked on the
 * request, an ended one releases the tabs offered it, chunks that record a
 * side effect are flushed at once, and a host with durable request records
 * (`Think`'s submissions) writes the request's result in the transaction
 * that settles the stream.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { StreamChunkData } from "./message-builder";
import { chunkMustBeStoredNow } from "./recovery-codec";
import type { ResumableStream } from "./resumable-stream";
import type { ChatTurnOutcome } from "./wire-types";

/**
 * What a host records for a request when its stream settles.
 *
 * @internal
 */
export type ReplyStreamResult =
  | { status: "completed"; output?: unknown }
  | { status: "aborted" | "retry" | "error" };

/** @internal */
export interface ReplyStreamsHost {
  /** The host's stream store. Read on every call: hosts assign it late. */
  resumable(): ResumableStream;
  /** A stream exists for the request: release the tabs parked on it. */
  streamStarted(requestId: string): void;
  /** The active stream ended: release the tabs offered it. */
  streamEnded(requestId: string | null): void;
  /** The user message ids the request answers, recorded on the stream. */
  originMessageIds(requestId: string): string[] | undefined;
  /** Run `fn` in one storage transaction. */
  transaction(fn: () => void): void;
  /**
   * Record how the request ended, inside the transaction that settles its
   * stream. Optional: only a host that keeps a durable record per request
   * has one.
   */
  record?(requestId: string, result: ReplyStreamResult): void;
}

/**
 * The metadata a reply's stream carries for orphan recovery and replay.
 *
 * @internal
 */
export interface ReplyStreamStart {
  /** The id the reply is stored under. */
  messageId?: string;
  /** The message a regeneration branches from. */
  parentMessageId?: string;
  /** For a reply that extends a stored message: its part count at start. */
  basePartCount?: number;
  continuation?: boolean;
}

/**
 * Per-stream flush bookkeeping for {@link ReplyStreams.store}.
 *
 * @internal
 */
export interface ReplyFlushState {
  chunksSinceFlush: number;
  hasFlushedContent: boolean;
}

/**
 * What the reply pump does to a reply's stream. {@link ReplyStreams} is the one implementation.
 *
 * @internal
 */
export interface ReplyStreamLog {
  start(requestId: string, options?: ReplyStreamStart): string;
  store(
    streamId: string,
    chunk: StreamChunkData,
    body: string,
    state: ReplyFlushState
  ): number | undefined;
  finish(streamId: string, outcome?: ChatTurnOutcome): void;
  complete(streamId: string, outcome?: ChatTurnOutcome): void;
  error(streamId: string, requestId?: string): void;
  completeStopped(streamId: string, requestId: string): void;
  completeForRetry(streamId: string, requestId: string): void;
  settlePending(requestId: string, result: ReplyStreamResult): void;
}

/** Text and reasoning are flushed with the first delta and every tenth after it. */
const DELTA_FLUSH_INTERVAL = 10;

/** @internal */
export class ReplyStreams implements ReplyStreamLog {
  constructor(private readonly host: ReplyStreamsHost) {}

  private get stream(): ResumableStream {
    return this.host.resumable();
  }

  /** Start the stream for a reply. */
  start(requestId: string, options: ReplyStreamStart = {}): string {
    const originIds = this.host.originMessageIds(requestId);
    const streamId = this.stream.start(requestId, {
      ...options,
      ...(originIds && { originMessageIds: originIds })
    });
    this.host.streamStarted(requestId);
    return streamId;
  }

  /**
   * Store a chunk. A tool call and a settled tool result are flushed at
   * once (`chunkMustBeStoredNow`): an eviction before the next flush would
   * lose a side effect. Text and reasoning deltas are flushed with the first
   * one and every tenth after it. Other chunks wait for the buffer.
   *
   * @returns The chunk's replay index, for the frame's `seq`.
   */
  store(
    streamId: string,
    chunk: StreamChunkData,
    body: string,
    state: ReplyFlushState
  ): number | undefined {
    const seq = this.stream.storeChunk(streamId, body);
    state.chunksSinceFlush++;
    const delta =
      chunk.type === "text-delta" || chunk.type === "reasoning-delta";
    if (
      chunkMustBeStoredNow(chunk.type) ||
      (delta &&
        (!state.hasFlushedContent ||
          state.chunksSinceFlush >= DELTA_FLUSH_INTERVAL))
    ) {
      this.stream.flushBuffer();
      state.chunksSinceFlush = 0;
      state.hasFlushedContent = true;
    }
    return seq;
  }

  /**
   * The producer finished. The row stays for the cutover that stores the
   * reply; every path that calls this ends in that cutover or
   * {@link settlePending}.
   */
  finish(streamId: string, outcome?: ChatTurnOutcome): void {
    const requestId = this.stream.activeRequestId;
    this.stream.finish(streamId, outcome);
    this.host.streamEnded(requestId);
  }

  /** Settle the stream now, with no cutover to follow. */
  complete(streamId: string, outcome?: ChatTurnOutcome): void {
    const requestId = this.stream.activeRequestId;
    this.stream.complete(streamId, outcome);
    this.host.streamEnded(requestId);
  }

  /**
   * Mark the stream errored. The request's record says `error`: recovery
   * may still retry the turn, and the stamp outlives the stream's rows.
   */
  error(streamId: string, requestId?: string): void {
    this.host.streamEnded(this.stream.activeRequestId);
    this.host.transaction(() => {
      this.stream.markError(streamId);
      if (requestId !== undefined) {
        this.host.record?.(requestId, { status: "error" });
      }
    });
  }

  /**
   * Close the stream of a reply a stop ended while its interruption was
   * routed. Its partial is stored already, so no cutover follows. The
   * record says `aborted`, in the same transaction: a reset in between
   * would read the closed stream as a completed request.
   */
  completeStopped(streamId: string, requestId: string): void {
    const active = this.stream.activeRequestId;
    this.host.transaction(() => {
      this.host.record?.(requestId, { status: "aborted" });
      this.stream.complete(streamId, "aborted");
    });
    this.host.streamEnded(active);
  }

  /**
   * Close the stream of an attempt the host runs again (a context overflow
   * retry). Its chunks stay for readers, but it is not the request's answer.
   */
  completeForRetry(streamId: string, requestId: string): void {
    this.host.transaction(() => {
      this.complete(streamId);
      this.host.record?.(requestId, { status: "retry" });
    });
  }

  /**
   * Settle a finished stream that no cutover consumed: the reply held
   * nothing to store, or its store did not reach the cutover. The record
   * takes the request's result in the same transaction.
   */
  settlePending(requestId: string, result: ReplyStreamResult): void {
    if (this.stream.pendingCutoverId === null) return;
    this.host.transaction(() => {
      this.stream.finalizePending();
      this.host.record?.(requestId, result);
    });
  }
}
