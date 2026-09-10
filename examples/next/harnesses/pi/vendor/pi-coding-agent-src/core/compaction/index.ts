// STUB — not upstream pi code. See vendor/pi-coding-agent-src/README.md

/**
 * Upstream re-exports its own compaction implementation here. The harness runs
 * pi-agent-core's compaction, so the preparation type is re-exported from there
 * and only the coding-agent-shaped result type is restated.
 */

import type { Usage } from "@earendil-works/pi-ai";

export type { CompactionPreparation } from "@earendil-works/pi-agent-core";

export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	/** Usage from the LLM call(s) that generated this summary, if available */
	usage?: Usage;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}
