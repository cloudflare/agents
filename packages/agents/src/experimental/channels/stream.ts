import { TextSegmentJoiner } from "../../chat/text-segment-joiner";
import type { Awaitable } from "./channel";
import type { ResponseChunk } from "./protocol";

/** Why a consumption loop stopped reading. */
export type StreamOutcome =
  | { interrupted: false }
  | { interrupted: true; error: unknown };

export type ChunkConsumer<TChunk, TResult> = {
  onChunk(chunk: TChunk): Awaitable<void>;
  /** Runs exactly once, whether the stream closed or ended abnormally. */
  onFinish(outcome: StreamOutcome): Awaitable<TResult>;
};

/** The complete text of a stream, and whether it ended before its answer did. */
export type CollectedText = {
  text: string;
  interrupted: boolean;
};

/**
 * Read a stream to completion, then finalize exactly once.
 *
 * `onFinish` runs whether the stream closed normally, errored because the
 * generation failed, or stopped because `onChunk` threw. A Channel that
 * finalizes here cannot lose a terminal provider call to an early ending.
 */
export async function consumeChunks<TChunk, TResult>(
  chunks: ReadableStream<TChunk>,
  consumer: ChunkConsumer<TChunk, TResult>
): Promise<TResult> {
  const reader = chunks.getReader();
  let outcome: StreamOutcome = { interrupted: false };
  let cancellation: Promise<void> | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await consumer.onChunk(value);
    }
  } catch (error) {
    outcome = { interrupted: true, error };
    // Start cancellation before finalizing, but do not block the terminal
    // provider call on sibling tee branches. Await cleanup only afterward.
    cancellation = reader.cancel().catch(() => {});
  } finally {
    reader.releaseLock();
  }
  try {
    return await consumer.onFinish(outcome);
  } finally {
    await cancellation;
  }
}

/**
 * Turn a response's chunks into answer text, one chunk at a time. Deltas of
 * one part join directly; a new text part or tool activity in between adds a
 * space. Metadata and data never split text. Returns the text each chunk adds.
 */
export function createTextCollector(): (chunk: ResponseChunk) => string {
  const joiner = new TextSegmentJoiner();
  return (chunk) => {
    if (
      chunk.type === "metadata" ||
      chunk.type === "data" ||
      chunk.type === "text-end"
    ) {
      return "";
    }
    let added = "";
    for (const event of joiner.pushChunk(
      chunk.type === "text-delta"
        ? { type: "text-delta", text: chunk.delta }
        : { type: chunk.type }
    )) {
      if (event.type === "text") added += event.text;
    }
    return added;
  };
}

/**
 * Collect a response's text into one Markdown answer.
 *
 * The result reports interruption instead of throwing, because a Channel that
 * has partial text still has to decide what to deliver.
 */
export function collectText(
  chunks: ReadableStream<ResponseChunk>
): Promise<CollectedText> {
  let text = "";
  const collect = createTextCollector();
  return consumeChunks(chunks, {
    onChunk(chunk) {
      text += collect(chunk);
    },
    onFinish: (outcome) => ({ text, interrupted: outcome.interrupted })
  });
}

/** A finished message as a response's chunks. */
export function messageChunks(markdown: string): ReadableStream<ResponseChunk> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "message" });
      controller.enqueue({
        type: "text-delta",
        id: "message",
        delta: markdown
      });
      controller.enqueue({ type: "text-end", id: "message" });
      controller.close();
    }
  });
}

/**
 * Pace repeated provider calls without dropping anything.
 *
 * A Channel accumulates into its own buffer and asks whether enough time has
 * passed to flush. Keeping the buffer in the Channel means an interrupted
 * stream leaves its tail in hand, ready for the terminal provider call, rather
 * than stranded inside a transform.
 */
export function createPacer(intervalMs: number): () => boolean {
  let lastFlushAt = Number.NEGATIVE_INFINITY;
  return () => {
    const now = Date.now();
    if (now - lastFlushAt < intervalMs) return false;
    lastFlushAt = now;
    return true;
  };
}
