import type { Awaitable } from "./channel";

/** Why a consumption loop stopped reading. */
export type StreamOutcome =
  | { interrupted: false }
  | { interrupted: true; error: unknown };

export type ChunkConsumer<TChunk, TResult> = {
  onChunk(chunk: TChunk): Awaitable<void>;
  /** Runs exactly once, whether the stream closed or ended abnormally. */
  onFinish(outcome: StreamOutcome): Awaitable<TResult>;
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
