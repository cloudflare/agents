import type { UIMessageChunk } from "ai";

/**
 * Coalescing window for the chunk burst a resumed stream replays.
 *
 * On reconnect the server re-sends every stored chunk of the active turn
 * back-to-back — one `cf_agent_use_chat_response` frame per chunk, marked
 * `replay: true`. Rebuilding chat state once per chunk is quadratic in the
 * turn's length, because each rebuild deep-clones the assistant message, and it
 * schedules one synchronous React render per chunk. A burst delivered inside a
 * single task therefore exceeds React's nested-update limit: "Maximum update
 * depth exceeded" (#1913), which reaches the user as a false terminal
 * `status: "error"` while the server-side turn is healthy.
 *
 * The window buffers replayed chunks and merges consecutive deltas of the same
 * part, so a burst applies as roughly one chunk per message part.
 *
 * Coalescing is best-effort. The first buffered chunk opens the window and a
 * `setTimeout(0)` closes it. That timer is a fresh macrotask: it runs no
 * earlier than the end of the current task, but other queued tasks — a socket
 * message, a close — can run before it. A burst split that way is delivered in
 * pieces, which is harmless, since only a burst inside one task can exceed the
 * limit.
 *
 * Correctness never depends on when the timer fires. Three things close the
 * window in a defined order:
 *
 * - A burst boundary flushes synchronously (`applyChatResponseFrame`).
 * - The transport flushes before it closes or detaches a stream, so a
 *   disconnect mid-burst cannot lose received content.
 * - A newer replay of a buffered message supersedes it
 *   (`supersedesBufferedPass`), so two replays of one turn are never
 *   concatenated — what the hook repairs when the passes apply separately
 *   (#1733).
 */
export class ReplayChunkBatch {
  /** Buffered chunks, in wire order. Owned by the batch — merged in place. */
  private chunks: UIMessageChunk[] = [];
  /** Merge key of the last buffered chunk, or null if it cannot be merged into. */
  private tailMergeKey: string | null = null;
  /** Cancels the scheduled flush. Set while the window is open. */
  private cancelWindow: (() => void) | undefined;
  /** `messageId` of the buffered pass, if it began with a `start` chunk. */
  private startMessageId: string | undefined;

  constructor(
    private readonly controller: ReadableStreamDefaultController<UIMessageChunk>,
    /** Schedules the flush, returning a canceller. Injected by tests. */
    private readonly closeWindow: (flush: () => void) => () => void = (
      flush
    ) => {
      const timer = setTimeout(flush, 0);
      return () => clearTimeout(timer);
    }
  ) {}

  get bufferedStartMessageId(): string | undefined {
    return this.startMessageId;
  }

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  /**
   * Buffers a replayed chunk, merging it into the previous one when both are
   * deltas of the same part. Takes ownership of the chunk, and opens the window
   * on the first one.
   */
  push(chunk: UIMessageChunk): void {
    const key = mergeKeyOf(chunk);
    const tail = this.chunks[this.chunks.length - 1];

    if (tail !== undefined && key !== null && key === this.tailMergeKey) {
      appendDeltaText(tail, chunk);
      return;
    }

    if (this.chunks.length === 0) {
      this.cancelWindow = this.closeWindow(() => {
        this.cancelWindow = undefined;
        this.flush();
      });
    }

    if (chunk.type === "start") {
      this.startMessageId = chunk.messageId;
    }
    this.chunks.push(chunk);
    this.tailMergeKey = key;
  }

  /**
   * Drops the buffered pass. Only for a pass that a newer replay of the same
   * message supersedes — nothing buffered has reached the consumer yet.
   */
  discard(): void {
    this.cancelWindow?.();
    this.cancelWindow = undefined;
    this.chunks = [];
    this.tailMergeKey = null;
    this.startMessageId = undefined;
  }

  /** Enqueues the buffered batch in wire order and closes the window. */
  flush(): void {
    this.cancelWindow?.();
    this.cancelWindow = undefined;

    if (this.chunks.length === 0) return;
    const batch = this.chunks;
    this.chunks = [];
    this.tailMergeKey = null;
    this.startMessageId = undefined;
    try {
      for (const chunk of batch) {
        this.controller.enqueue(chunk);
      }
    } catch {
      // Already closed or errored, which discards the stream's queue anyway. A
      // flush must never throw: callers flush on their way to closing a stream,
      // and still have to close it.
    }
  }

  /**
   * Writes a chunk straight to the stream. Callers flush first — every write
   * goes through the batch so nothing can overtake replayed content.
   */
  enqueueNow(chunk: UIMessageChunk): void {
    this.controller.enqueue(chunk);
  }

  closeNow(): void {
    this.controller.close();
  }

  errorNow(error: Error): void {
    this.controller.error(error);
  }
}

/** The subset of `cf_agent_use_chat_response` a chunk stream needs to route a frame. */
type ChatResponseFrame = {
  body?: string;
  continuation?: boolean;
  done?: boolean;
  replay?: boolean;
  replayComplete?: boolean;
};

/**
 * Routes one non-error `cf_agent_use_chat_response` frame into a chunk stream.
 * A replayed chunk joins the window; anything else flushes it first, so
 * replayed content always reaches the consumer ahead of live content.
 *
 * A burst also ends at `replayComplete` (live stream) or `done` (finalized or
 * orphaned stream, which sends no `replayComplete`). Either can carry an empty
 * body, so bodyless frames flush too.
 */
export function applyChatResponseFrame(
  batch: ReplayChunkBatch,
  frame: ChatResponseFrame
): void {
  const endsReplayBurst =
    frame.replay !== true ||
    frame.done === true ||
    frame.replayComplete === true;

  const body = frame.body?.trim();
  if (!body) {
    if (endsReplayBurst) batch.flush();
    return;
  }

  let chunk: UIMessageChunk;
  try {
    chunk = JSON.parse(body) as UIMessageChunk;
  } catch {
    // Skip malformed chunk bodies, but don't strand a finished batch behind one.
    if (endsReplayBurst) batch.flush();
    return;
  }

  if (endsReplayBurst) {
    batch.flush();
    batch.enqueueNow(chunk);
    return;
  }

  if (supersedesBufferedPass(batch, chunk, frame)) {
    batch.discard();
  }

  batch.push(chunk);
}

/**
 * True when `chunk` starts a replay pass that makes the buffered one redundant.
 *
 * A stream can announce itself twice, so one turn can replay twice before
 * either pass is delivered (#1733). Every replay rebuilds the message from its
 * first chunk, so the newer pass contains the buffered one, which has reached
 * nobody; delivering both would duplicate the message's parts. Continuation
 * replays append instead of rebuilding, so they never supersede.
 */
function supersedesBufferedPass(
  batch: ReplayChunkBatch,
  chunk: UIMessageChunk,
  frame: ChatResponseFrame
): boolean {
  return (
    chunk.type === "start" &&
    frame.continuation !== true &&
    chunk.messageId !== undefined &&
    chunk.messageId === batch.bufferedStartMessageId
  );
}

/**
 * Terminates a chunk stream with an error, without losing buffered content.
 *
 * Resuming an errored turn replays its partial content and only then sends the
 * terminal error frame (#1575). `controller.error()` resets the stream's queue,
 * so with content buffered the error is delivered as an `error` chunk behind
 * the flushed batch instead. `processUIMessageStream` turns that into the same
 * thrown error, so `useChat` still lands in `status: "error"`.
 */
export function failChatStream(batch: ReplayChunkBatch, message: string): void {
  if (batch.isEmpty) {
    batch.errorNow(new Error(message));
    return;
  }

  batch.flush();
  batch.enqueueNow({ errorText: message, type: "error" });
  batch.closeNow();
}

/**
 * Identity of the part a chunk adds text to, or null when the chunk must not be
 * merged into: non-deltas, and deltas carrying metadata.
 */
function mergeKeyOf(chunk: UIMessageChunk): string | null {
  switch (chunk.type) {
    case "text-delta":
    case "reasoning-delta":
      return chunk.providerMetadata === undefined
        ? `${chunk.type}\u0000${chunk.id}`
        : null;
    case "tool-input-delta":
      return `tool-input-delta\u0000${chunk.toolCallId}`;
    default:
      return null;
  }
}

/** Appends `source`'s delta text onto `target`. Both have equal merge keys. */
function appendDeltaText(target: UIMessageChunk, source: UIMessageChunk): void {
  if (
    target.type === "tool-input-delta" &&
    source.type === "tool-input-delta"
  ) {
    target.inputTextDelta += source.inputTextDelta;
    return;
  }
  if (
    (target.type === "text-delta" || target.type === "reasoning-delta") &&
    (source.type === "text-delta" || source.type === "reasoning-delta")
  ) {
    target.delta += source.delta;
  }
}
