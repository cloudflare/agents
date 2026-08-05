import type { UIMessageChunk } from "ai";

/**
 * Coalescing buffer for the chunk burst a resumed stream replays.
 *
 * On reconnect the server re-sends every stored chunk of the active turn
 * back-to-back — one `cf_agent_use_chat_response` frame per chunk, each marked
 * `replay: true` — and closes the burst with `replayComplete` (stream still
 * live) or `done` (stream already finalized). Forwarding each replayed chunk
 * into the UI-message stream individually rebuilds chat state once per chunk,
 * which has two costs:
 *
 * 1. Every rebuild deep-clones the whole assistant message, so replaying a long
 *    turn is quadratic in its length.
 * 2. Every rebuild schedules a synchronous React render. A burst long enough
 *    outpaces React's commit loop and trips its nested-update guard —
 *    "Maximum update depth exceeded" (#1913) — which surfaces as a false
 *    terminal `status: "error"` even though the server-side turn is healthy.
 *
 * Buffering the burst and merging consecutive deltas of the same part reduces
 * the replayed prefix to roughly one chunk per message part, so it applies in
 * one pass and the already-streamed text stops visibly re-typing.
 *
 * Only *adjacent* deltas of the same part are merged, so ordering across parts
 * is preserved exactly, and deltas carrying `providerMetadata` are kept whole
 * so no metadata is summed away.
 */
export class ReplayChunkBatch {
  /** Buffered chunks, in wire order. Owned by the batch — merged in place. */
  private chunks: UIMessageChunk[] = [];
  /** Merge key of the last buffered chunk, or null if it cannot be merged into. */
  private tailMergeKey: string | null = null;

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  /**
   * Buffers a replayed chunk, merging it into the previous one when both are
   * deltas of the same part. Takes ownership of the chunk.
   */
  push(chunk: UIMessageChunk): void {
    const key = mergeKeyOf(chunk);
    const tail = this.chunks[this.chunks.length - 1];

    if (tail !== undefined && key !== null && key === this.tailMergeKey) {
      appendDeltaText(tail, chunk);
      return;
    }

    this.chunks.push(chunk);
    this.tailMergeKey = key;
  }

  /** Enqueues the buffered batch in wire order and resets the batch. */
  flush(controller: ReadableStreamDefaultController<UIMessageChunk>): void {
    if (this.chunks.length === 0) return;
    const batch = this.chunks;
    this.chunks = [];
    this.tailMergeKey = null;
    for (const chunk of batch) {
      controller.enqueue(chunk);
    }
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
 * mid-burst replay chunks are buffered, anything else flushes the batch first
 * so replayed content always reaches the consumer ahead of live content.
 *
 * A burst ends at `replayComplete` (live stream), at `done` (finalized or
 * orphaned stream, which never sends `replayComplete`), or at the first
 * non-replay frame. Both terminators must flush, and `replayComplete` frames
 * carry an empty body — hence the flush on bodyless frames too.
 */
export function applyChatResponseFrame(
  batch: ReplayChunkBatch,
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  frame: ChatResponseFrame
): void {
  const endsReplayBurst =
    frame.replay !== true ||
    frame.done === true ||
    frame.replayComplete === true;

  const body = frame.body?.trim();
  if (!body) {
    if (endsReplayBurst) batch.flush(controller);
    return;
  }

  let chunk: UIMessageChunk;
  try {
    chunk = JSON.parse(body) as UIMessageChunk;
  } catch {
    // Skip malformed chunk bodies, but don't strand a finished batch behind one.
    if (endsReplayBurst) batch.flush(controller);
    return;
  }

  if (endsReplayBurst) {
    batch.flush(controller);
    controller.enqueue(chunk);
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
export function failChatStream(
  batch: ReplayChunkBatch,
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  message: string
): void {
  if (batch.isEmpty) {
    controller.error(new Error(message));
    return;
  }

  batch.flush(controller);
  controller.enqueue({ type: "error", errorText: message });
  controller.close();
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
