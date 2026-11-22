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

import type { UIMessage } from "ai";
import { settleInterruptedPart, type StreamChunkData } from "./message-builder";
import { persistReconstructedOrphan } from "./orphan-persist";
import type { OrphanPersistStore } from "./orphan-store";
import { chunkMustBeStoredNow } from "./recovery-codec";
import { streamChunksFinished } from "./repair-transcript";
import { replyIsEmpty } from "./reply-empty";
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
  /** The user message ids the request answers (terminal frames echo them). */
  originMessageIds(requestId: string): string[] | undefined;
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

/**
 * Whether the rebuilt reply holds everything the stored message does, part
 * by part: the same tool calls in the same places, and text and reasoning
 * the rebuilt parts start with. A reply rebuilt a second time covers the
 * first rebuild. The stream of a continuation that holds only its own
 * parts does not cover the message it continued.
 */
function rebuildCovers(existing: UIMessage, incoming: UIMessage): boolean {
  // Parts that carry nothing (a step marker, an empty text or reasoning
  // part with no provider data) are dropped by some stores, so they do not
  // count either way. Empty reasoning with provider data (redacted
  // thinking) is kept by every store, and counts.
  const counted = (message: UIMessage) =>
    message.parts.filter((part) => {
      const p = part as {
        type?: unknown;
        text?: unknown;
        providerMetadata?: unknown;
      };
      if (p.type === "step-start") return false;
      if (p.type === "text" || p.type === "reasoning") {
        return (
          (typeof p.text === "string" && p.text.length > 0) ||
          p.providerMetadata !== undefined
        );
      }
      return true;
    }) as Array<Record<string, unknown>>;
  const stored = counted(existing);
  const rebuilt = counted(incoming);
  if (stored.length > rebuilt.length) return false;
  return stored.every((part, index) => {
    const next = rebuilt[index];
    if (part.type !== next.type) return false;
    if (typeof part.toolCallId === "string") {
      return part.toolCallId === next.toolCallId;
    }
    if (typeof part.text === "string") {
      return typeof next.text === "string" && next.text.startsWith(part.text);
    }
    return true;
  });
}

/** How far a tool part has got. */
const TOOL_STATE_RANK: Record<string, number> = {
  "input-streaming": 0,
  "input-available": 1,
  "approval-requested": 2,
  "approval-responded": 3,
  "output-available": 4,
  "output-error": 4,
  "output-denied": 4
};

function toolRank(part: unknown): number {
  const state = (part as { state?: unknown }).state;
  return typeof state === "string" ? (TOOL_STATE_RANK[state] ?? -1) : -1;
}

/**
 * `incoming` with each tool part the stored copy has got at least as far
 * with replaced by the stored part. A result or an approval that arrived after
 * the stream lost its producer was written to the stored message, never to
 * the stream. A result the stream itself carries for a call the message
 * held before (a continuation's) is newer, and stays.
 */
function keepStoredToolParts(
  existing: UIMessage,
  incoming: UIMessage
): UIMessage {
  const stored = new Map<string, UIMessage["parts"][number]>();
  for (const part of existing.parts) {
    if ("toolCallId" in part && typeof part.toolCallId === "string") {
      stored.set(part.toolCallId, part);
    }
  }
  if (stored.size === 0) return incoming;
  return {
    ...incoming,
    parts: incoming.parts.map((part) => {
      if (!("toolCallId" in part) || typeof part.toolCallId !== "string") {
        return part;
      }
      const kept = stored.get(part.toolCallId);
      return kept && toolRank(kept) >= toolRank(part) ? kept : part;
    })
  };
}

/**
 * How a host stores the reply an orphaned stream holds.
 *
 * @internal
 */
export interface OrphanReplyOptions {
  /** Where the reply is read and written. `appendMessage` gets the parent. */
  store: OrphanPersistStore;
  /** Settle the calls a cut-off reply left unanswered. */
  settle(message: UIMessage): UIMessage;
  /**
   * The host's last step before the write (`Think` strips internal parts).
   * `null` stores nothing.
   */
  prepare?(message: UIMessage): UIMessage | null;
  /** The id for a stream from before the id was recorded on it. */
  legacyMessageId?(): string | undefined;
  /**
   * Combine the stored message with the rebuilt reply of a stream that
   * holds only part of it: one from before the id was recorded, or a
   * continuation from before its base part count was.
   */
  mergeLegacy?(existing: UIMessage, incoming: UIMessage): UIMessage;
}

/** Text and reasoning are flushed with the first delta and every tenth after it. */
const DELTA_FLUSH_INTERVAL = 10;

/** @internal */
export class ReplyStreams implements ReplyStreamLog {
  constructor(private readonly host: ReplyStreamsHost) {}

  private get stream(): ResumableStream {
    return this.host.resumable();
  }

  originMessageIds(requestId: string): string[] | undefined {
    return this.host.originMessageIds(requestId);
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
   * Rebuild the reply a stream holds and store it: the stream lost its
   * producer (an eviction, a deploy) before the reply was stored. A reply
   * that extended a stored message is replayed onto that message's parts
   * from when the stream started, so storing it twice rewrites it once
   * (#2780). A stream with no `finish` chunk was cut off, and its
   * unanswered calls are settled; one that finished keeps them, since
   * those wait for a client. A reply that holds nothing is not stored.
   *
   * Does not count as progress: the chunks were counted when stored.
   *
   * @returns The id the reply was stored under, or `undefined`.
   */
  async persistOrphan(
    streamId: string,
    options: OrphanReplyOptions
  ): Promise<string | undefined> {
    const stream = this.stream;
    stream.flushBuffer();
    const chunks = stream.getStreamChunks(streamId);
    if (chunks.length === 0) return undefined;
    const messageId = stream.getStreamMessageId(streamId);
    const basePartCount = stream.getStreamBasePartCount(streamId);
    const parentId = stream.getStreamParentMessageId(streamId) ?? undefined;
    const finished = streamChunksFinished(chunks);
    const { store } = options;
    let storedId: string | undefined;
    const continues = messageId !== null && basePartCount !== null;
    // A stream whose chunks are only part of the message: one that records
    // no id, or a continuation from before the base part count was recorded.
    // A stream imported from before the continuation flag was recorded
    // looks like a reply of its own: `rebuildCovers` tells them apart below.
    const legacy =
      messageId === null ||
      (!continues && stream.getStreamIsContinuation(streamId));
    const wrote = await persistReconstructedOrphan(chunks, {
      store: {
        ...store,
        appendMessage: (message) => store.appendMessage(message, parentId)
      },
      ...(continues && {
        continues: {
          messageId,
          basePartCount,
          settleBasePart: settleInterruptedPart
        }
      }),
      fallbackId:
        messageId ?? options.legacyMessageId?.() ?? crypto.randomUUID(),
      prepare: (message) => {
        const settled = finished ? message : options.settle(message);
        const prepared = options.prepare ? options.prepare(settled) : settled;
        if (prepared === null || replyIsEmpty(prepared)) return null;
        storedId = prepared.id;
        return prepared;
      },
      merge: (existing, incoming) => {
        // The rebuilt reply is the whole message (a reply of its own, or
        // one replayed onto the message's earlier parts), except for tool
        // calls the stored copy got as far with: a result or an approval is
        // written to the stored message, never to the stream.
        const partial =
          legacy || (!continues && !rebuildCovers(existing, incoming));
        const merged =
          partial && options.mergeLegacy
            ? options.mergeLegacy(existing, incoming)
            : keepStoredToolParts(existing, incoming);
        return finished ? merged : options.settle(merged);
      }
    });
    return wrote ? storedId : undefined;
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
