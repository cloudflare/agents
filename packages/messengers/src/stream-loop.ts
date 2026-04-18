/**
 * Shared post+edit streaming loop used by all adapters.
 *
 * Posts an initial placeholder message, then edits it as chunks
 * arrive from the stream. Throttles edits to avoid rate limits.
 */

export interface StreamLoopOptions {
  postInitial: () => Promise<string>;
  editMessage: (id: string, text: string) => Promise<void>;
  updateIntervalMs?: number;
}

export async function streamLoop(
  stream: AsyncIterable<string>,
  options: StreamLoopOptions
): Promise<{ id: string; text: string }> {
  const { postInitial, editMessage, updateIntervalMs = 500 } = options;

  const id = await postInitial();
  let accumulated = "";
  let lastUpdate = 0;

  for await (const chunk of stream) {
    accumulated += chunk;
    const now = Date.now();

    if (now - lastUpdate >= updateIntervalMs) {
      try {
        await editMessage(id, accumulated);
      } catch {
        // Edit may fail if content unchanged
      }
      lastUpdate = now;
    }
  }

  try {
    await editMessage(id, accumulated || "(no response)");
  } catch {
    // Final edit may fail if content unchanged
  }

  return { id, text: accumulated };
}
