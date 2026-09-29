import type { UIMessageChunk } from "ai";

/**
 * Batches chunks replayed during stream resume.
 *
 * Replaying every chunk separately can exceed React's update limit. Adjacent
 * deltas for the same message part are merged until the replay pauses or ends.
 */
export class ReplayChunkBatch {
  private chunks: UIMessageChunk[] = [];
  private tailMergeKey: string | null = null;
  private cancelWindow: (() => void) | undefined;
  private startMessageId: string | undefined;

  constructor(
    private readonly controller: ReadableStreamDefaultController<UIMessageChunk>,
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

  discard(): void {
    this.cancelWindow?.();
    this.cancelWindow = undefined;
    this.chunks = [];
    this.tailMergeKey = null;
    this.startMessageId = undefined;
  }

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
      // The stream is already closed; callers still need to finish cleanup.
    }
  }

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

type ChatResponseFrame = {
  body?: string;
  continuation?: boolean;
  done?: boolean;
  replay?: boolean;
  replayComplete?: boolean;
};

/** Buffers replay chunks and flushes them before live or boundary frames. */
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
    // Do not leave buffered chunks behind a malformed boundary frame.
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
 * Reports an error after buffered content. `controller.error()` would discard
 * chunks that have not reached the consumer.
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
