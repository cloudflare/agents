/**
 * Think SessionManager — re-exports from agents Session API
 * with Think-specific truncation utilities.
 */

export {
  SessionManager,
  type SessionInfo,
  type SessionManagerOptions,
} from "agents/experimental/memory/session";

// Keep backward compat
export type { SessionInfo as Session } from "agents/experimental/memory/session";
export type { StoredCompaction as Compaction } from "agents/experimental/memory/session";

// ── Truncation utilities ─────────────────────────────────────────

const DEFAULT_MAX_CHARS = 30_000;
const ELLIPSIS = "\n\n... [truncated] ...\n\n";

export function truncateHead(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const keep = maxChars - ELLIPSIS.length;
  if (keep <= 0) return text.slice(-maxChars);
  return ELLIPSIS + text.slice(-keep);
}

export function truncateTail(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const keep = maxChars - ELLIPSIS.length;
  if (keep <= 0) return text.slice(0, maxChars);
  return text.slice(0, keep) + ELLIPSIS;
}

export function truncateLines(text: string, maxLines = 200): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(0, maxLines).join("\n");
  return kept + `\n\n... [${lines.length - maxLines} more lines truncated] ...`;
}

export function truncateMiddle(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const halfKeep = Math.floor((maxChars - ELLIPSIS.length) / 2);
  if (halfKeep <= 0) return text.slice(0, maxChars);
  return text.slice(0, halfKeep) + ELLIPSIS + text.slice(-halfKeep);
}

export function truncateToolOutput(
  output: string,
  options: { maxChars?: number; maxLines?: number; strategy?: "head" | "tail" | "middle" } = {}
): string {
  const { maxChars = DEFAULT_MAX_CHARS, maxLines = 500, strategy = "tail" } = options;
  let result = truncateLines(output, maxLines);
  if (result.length > maxChars) {
    switch (strategy) {
      case "head": result = truncateHead(result, maxChars); break;
      case "middle": result = truncateMiddle(result, maxChars); break;
      default: result = truncateTail(result, maxChars); break;
    }
  }
  return result;
}
