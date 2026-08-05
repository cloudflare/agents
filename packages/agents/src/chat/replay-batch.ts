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
 * The window is deliberately short: it closes at the end of the event-loop turn
 * that opened it, or earlier at a burst boundary. That bound is what makes the
 * burst safe to coalesce — a burst spread over several turns cannot trip
 * React's guard in the first place, and holding chunks longer would change the
 * order in which the hook's own replay bookkeeping in `chat/react.tsx` sees
 * state. That bookkeeping repairs a second replay of the same turn (#1733) by
 * inspecting messages already applied, so replayed content must never be held
 * across the frames that trigger it.
 */
export class ReplayChunkBatch {
  /** Buffered chunks, in wire order. Owned by the batch — merged in place. */
  private chunks: UIMessageChunk[] = [];
  /** Merge key of the last buffered chunk, or null if it cannot be merged into. */
  private tailMergeKey: string | null = null;
  /** Cancels the pending end-of-turn flush. Set while the window is open. */
  private cancelWindow: (() => void) | undefined;

  constructor(
    private readonly controller: ReadableStreamDefaultController<UIMessageChunk>,
    /** Schedules the end-of-turn flush. Overridable for deterministic tests. */
    private readonly closeWindow: (flush: () => void) => () => void = (
      flush
    ) => {
      const timer = setTimeout(flush, 0);
      return () => clearTimeout(timer);
    }
  ) {}

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
        try {
          this.flush();
        } catch {
          // The stream can close before the window elapses.
        }
      });
    }

    this.chunks.push(chunk);
    this.tailMergeKey = key;
  }

  /** Enqueues the buffered batch in wire order and closes the window. */
  flush(): void {
    this.cancelWindow?.();
    this.cancelWindow = undefined;

    if (this.chunks.length === 0) return;
    const batch = this.chunks;
    this.chunks = [];
    this.tailMergeKey = null;
    for (const chunk of batch) {
      this.controller.enqueue(chunk);
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

  batch.push(chunk);
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
