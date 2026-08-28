import { TextSegmentJoiner } from "agents/chat";
import type { Awaitable, ChannelChunk } from "./channel";

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
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await consumer.onChunk(value);
    }
  } catch (error) {
    outcome = { interrupted: true, error };
    // Stop the producer, which is still generating when `onChunk` threw.
    await reader.cancel().catch(() => {});
  } finally {
    reader.releaseLock();
  }
  return consumer.onFinish(outcome);
}

/**
 * Collect every `text` chunk into one Markdown answer.
 *
 * The result reports interruption instead of throwing, because a Channel that
 * has partial text still has to decide what to deliver.
 */
export function collectText(
  chunks: ReadableStream<ChannelChunk>
): Promise<CollectedText> {
  let text = "";
  const joiner = new TextSegmentJoiner();
  return consumeChunks(chunks, {
    onChunk(chunk) {
      for (const event of joiner.pushChunk(
        chunk.type === "text"
          ? { type: "text-delta", text: chunk.text }
          : { type: chunk.type }
      )) {
        if (event.type === "text") text += event.text;
      }
    },
    onFinish: (outcome) => ({ text, interrupted: outcome.interrupted })
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
