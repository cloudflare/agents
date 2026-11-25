import type { AgentToolStoredChunk } from "./agent-tool-types";

/**
 * Read every stored chunk after `afterSequence`, one page at a time: a page
 * is one reply of `getAgentToolChunks`, at most `REPLAY_PAGE_BYTES`.
 *
 * @internal
 */
export async function allChunks(
  page: (
    afterSequence: number | undefined
  ) => AgentToolStoredChunk[] | Promise<AgentToolStoredChunk[]>,
  afterSequence: number | undefined,
  each: (chunk: AgentToolStoredChunk) => void
): Promise<void> {
  let after = afterSequence;
  for (;;) {
    const chunks = await page(after);
    const from = after ?? -1;
    const fresh = chunks.filter((chunk) => chunk.sequence > from);
    // An empty page ends the read, and so does a page with nothing new: a
    // reader that ignores `afterSequence` answers everything every time.
    if (fresh.length === 0) return;
    for (const chunk of fresh) each(chunk);
    after = fresh[fresh.length - 1].sequence;
  }
}
