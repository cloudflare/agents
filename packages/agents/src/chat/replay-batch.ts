import type { UIMessageChunk } from "ai";

/**
 * Coalescing window for the chunk burst a resumed stream replays.
 *
 * On reconnect the server re-sends every stored chunk of the active turn
 * back-to-back — one `cf_agent_use_chat_response` frame per chunk, each marked
 * `replay: true`. Forwarding each replayed chunk into the UI-message stream on
 * arrival rebuilds chat state once per chunk, which has two costs:
 *
 * 1. Every rebuild deep-clones the whole assistant message, so replaying a long
 *    turn is quadratic in its length.
 * 2. Every rebuild schedules a synchronous React render. A burst delivered in a
 *    single event-loop turn outpaces React's commit loop and trips its
 *    nested-update guard — "Maximum update depth exceeded" (#1913) — which
 *    surfaces as a false terminal `status: "error"` even though the server-side
 *    turn is healthy.
 *
 * The window collects replayed chunks and merges consecutive deltas of the same
 * part, so the burst applies as roughly one chunk per message part.
 *
 * The window is deliberately short. It is opened by the first buffered chunk
 * and closed by a `setTimeout(0)`, which runs once the task that delivered the
 * burst finishes. Coalescing is therefore opportunistic: a burst delivered in
 * one task is merged, and a burst spread over several tasks is delivered as it
 * arrives — which is harmless, because only a burst inside a single task can
 * outrun React's commit loop.
 *
 * Correctness does not depend on that timer winning any race, because the
 * timer is not the only thing that closes the window:
 *
 * - A burst boundary flushes synchronously (`applyChatResponseFrame`).
 * - The transport flushes before it closes or detaches a stream, so a
 *   disconnect mid-burst cannot lose received content.
 * - A replayed `start` for a message already buffered supersedes the buffered
 *   pass (`supersedesBufferedPass`), so two replays of one turn can never be
 *   concatenated — the case the hook's own bookkeeping repairs when the passes
 *   are applied separately (#1733).
 */
export class ReplayChunkBatch {
  /** Buffered chunks, in wire order. Owned by the batch — merged in place. */
  private chunks: UIMessageChunk[] = [];
  /** Merge key of the last buffered chunk, or null if it cannot be merged into. */
  private tailMergeKey: string | null = null;
  /** Cancels the pending end-of-turn flush. Set while the window is open. */
  private cancelWindow: (() => void) | undefined;

  /** `messageId` of the buffered replay pass, if it began with a `start`. */
  private startMessageId: string | undefined;

  constructor(
    private readonly controller: ReadableStreamDefaultController<UIMessageChunk>,
    /**
     * Schedules the window's flush and returns a canceller. Runs after the
     * current task by default; overridable for deterministic tests.
     */
    private readonly closeWindow: (flush: () => void) => () => void = (
      flush
    ) => {
      const timer = setTimeout(flush, 0);
      return () => clearTimeout(timer);
    }
  ) {}

  /** `messageId` of the buffered pass, or undefined if none is buffered. */
  get bufferedStartMessageId(): string | undefined {
    return this.startMessageId;
  }

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  /**
   * Buffers a replayed chunk, merging it into the previous one when both are
   * deltas of the same part. Takes ownership of the chunk. Opens the window on
   * the first chunk so the batch cannot outlive the turn that produced it.
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
      // The stream is already closed or errored, which discards its queue
      // anyway. Never let a flush throw: callers flush on their way to
      // closing a stream, and must still close it.
    }
  }

  /**
   * Writes a chunk straight to the stream. Callers flush first — every write
   * goes through the batch so nothing can overtake replayed content.
   */
  enqueueNow(chunk: UIMessageChunk): void {
    this.controller.enqueue(chunk);
  }

  /** Closes the stream. */
  closeNow(): void {
    this.controller.close();
  }

  /** Errors the stream, discarding anything still queued in it. */
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
 * Routes one non-error `cf_agent_use_chat_response` frame into a chunk stream:
 * a replayed chunk joins the current window, anything else flushes the window
 * first so replayed content always reaches the consumer ahead of live content.
 *
 * A burst also ends at `replayComplete` (live stream) or at `done` (finalized
 * or orphaned stream, which never sends `replayComplete`). Both flush, and both
 * can carry an empty body — hence the flush on bodyless frames too.
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
 * A stream can announce itself twice, so the same turn can replay twice before
 * either pass is delivered (#1733). Every replay rebuilds the message from its
 * first chunk, so the newer pass is a superset of the buffered one; delivering
 * both would duplicate the message's parts. Continuation replays are excluded:
 * they append to an existing message rather than rebuild it.
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
 * so with content still buffered the error is delivered as an `error` chunk
 * behind the flushed batch instead — `processUIMessageStream` turns that into
 * the same thrown error, so `useChat` still lands in `status: "error"`.
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
 * Identity of the part a chunk contributes text to, or null when the chunk
 * must not be merged into (non-delta chunks, and deltas carrying metadata).
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

/**
 * Appends `source`'s delta text onto `target`. Only called for chunks with
 * equal, non-null merge keys, so both are the same kind of delta.
 */
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
