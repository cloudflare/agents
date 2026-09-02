/**
 * Bounded maintenance over aged rows: it drains inline payloads at or above
 * the R2 threshold out to R2, so a drained row ends up exactly as if it had
 * been written today.
 *
 * Without a bucket this pass has no work to do. Moving a payload into SQLite
 * chunks does not reclaim a byte — the chunks live in the same Durable
 * Object as the row — so inline is the correct resting place and the pass
 * returns empty totals without reading a single row's content.
 *
 * Recent rows stay untouched either way, so the model's hot window never
 * pays a reconstruction read.
 */

import { MAX_INLINE_ROW_BYTES } from "./attachments";
import type { SessionsCore } from "./core";
import type { SessionMaintenanceResult } from "./types";

export async function runMaintenancePass(
  core: SessionsCore,
  sessionId: string
): Promise<SessionMaintenanceResult> {
  const options = core.attachments.options;
  const totals: SessionMaintenanceResult = {
    messages: 0,
    parts: 0,
    bytes: 0,
    backlogRemains: false
  };
  if (!options.bucket) return totals;

  const threshold = options.r2ThresholdBytes;
  const stats = core.pathRowStats(sessionId);
  const aged = stats
    .slice(0, Math.max(0, stats.length - options.keepRecentMessages))
    .map((row) => row.id);

  for (const candidate of core.maintenanceCandidates(
    sessionId,
    aged,
    threshold,
    options.maxMaintenanceRowsPerPass
  )) {
    // The same policy the write path applies, so a drained legacy row ends up
    // exactly as if it had been written today.
    const result = await core.attachments.offload(candidate.message, {
      rowBudgetBytes: MAX_INLINE_ROW_BYTES
    });
    if (result.parts === 0) {
      core.markMaintenanceCandidate(
        sessionId,
        candidate.message.id,
        candidate.content,
        0
      );
      continue;
    }
    const rewritten = await core.rewriteForMaintenance(
      sessionId,
      candidate.content,
      result.message,
      result.attachments,
      core.estimateRowTokens(result.message)
    );
    if (!rewritten) continue;
    totals.messages++;
    totals.parts += result.parts;
    totals.bytes += result.bytes;
    await core.notify({
      type: "maintenance-rewrite",
      sessionId,
      message: result.message
    });
  }

  totals.backlogRemains = core.hasMaintenanceCandidate(
    sessionId,
    aged,
    threshold
  );
  if (totals.messages > 0) {
    core.io.emit("session:maintenance:completed", { sessionId, ...totals });
  }
  return totals;
}
