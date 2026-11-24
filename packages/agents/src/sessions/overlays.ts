/**
 * The synthetic message a compaction overlay renders as on read. Overlays
 * are applied by the visible walk in `core.ts`.
 */

import { COMPACTION_PREFIX } from "./compaction-helpers";
import type { SessionMessage, StoredCompaction } from "./types";

/** The synthetic message an overlay renders as. */
export function overlayMessage(compaction: StoredCompaction): SessionMessage {
  return {
    id: `${COMPACTION_PREFIX}${compaction.id}`,
    role: "assistant",
    parts: [{ type: "text", text: compaction.summary }],
    createdAt: new Date()
  };
}
