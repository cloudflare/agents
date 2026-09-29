/**
 * Compaction overlay planning shared by the read path and the stats
 * derivation. Reproduces the selection semantics of the legacy
 * `applyCompactions` exactly: walk the path root → leaf; at each position the
 * newest overlay that starts here and ends at-or-after here on this branch
 * wins; its span is skipped and later overlaps inside the span never apply.
 */

import { COMPACTION_PREFIX } from "./compaction-helpers";
import type { SessionMessage, StoredCompaction } from "./types";

/** One planned overlay span over path indexes (inclusive). */
export interface OverlaySpan {
  startIndex: number;
  endIndex: number;
  compaction: StoredCompaction;
}

/** Plan overlay spans over an ordered list of path message ids. */
export function planOverlays(
  pathIds: readonly string[],
  compactions: readonly StoredCompaction[]
): OverlaySpan[] {
  if (compactions.length === 0) return [];
  const indexById = new Map(pathIds.map((id, index) => [id, index]));
  const spans: OverlaySpan[] = [];
  let i = 0;
  while (i < pathIds.length) {
    // Sibling branches can have compactions with the same starting message.
    // Consider only ranges ending on this branch, then let the latest valid
    // compaction supersede earlier ranges on the same branch.
    const matching = compactions.filter(
      (compaction) =>
        compaction.fromMessageId === pathIds[i] &&
        (indexById.get(compaction.toMessageId) ?? -1) >= i
    );
    const compaction = matching.at(-1);
    if (compaction) {
      const endIndex = indexById.get(compaction.toMessageId) ?? -1;
      if (endIndex >= i) {
        spans.push({ startIndex: i, endIndex, compaction });
        i = endIndex + 1;
        continue;
      }
    }
    i++;
  }
  return spans;
}

/** The synthetic message an overlay span renders as. */
export function overlayMessage(compaction: StoredCompaction): SessionMessage {
  return {
    id: `${COMPACTION_PREFIX}${compaction.id}`,
    role: "assistant",
    parts: [{ type: "text", text: compaction.summary }],
    createdAt: new Date()
  };
}
