/**
 * Output truncation utilities for tool results and text content.
 *
 * Prevents context window blowup from large tool outputs by
 * truncating content to a maximum length while preserving
 * useful information at the boundaries.
 */

const DEFAULT_MAX_CHARS = 30_000;
const ELLIPSIS = "\n\n... [truncated] ...\n\n";

/**
 * Truncate from the head (keep the end of the content).
 * Useful when the most recent output is most relevant.
 */
export function truncateHead(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS
): string {
  if (text.length <= maxChars) return text;
  const keep = maxChars - ELLIPSIS.length;
  if (keep <= 0) return text.slice(-maxChars);
  return ELLIPSIS + text.slice(-keep);
}

/**
 * Truncate from the tail (keep the start of the content).
 * Useful for command output where the beginning is most relevant.
 */
export function truncateTail(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS
): string {
  if (text.length <= maxChars) return text;
  const keep = maxChars - ELLIPSIS.length;
  if (keep <= 0) return text.slice(0, maxChars);
  return text.slice(0, keep) + ELLIPSIS;
}

/**
 * Truncate by line count (keep the first N lines).
 * Useful for limiting output from commands that produce many lines.
 */
export function truncateLines(text: string, maxLines: number = 200): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(0, maxLines).join("\n");
  const omitted = lines.length - maxLines;
  return kept + `\n\n... [${omitted} more lines truncated] ...`;
}

/**
 * Truncate from both ends, keeping the start and end with a gap in the middle.
 * Useful when both the beginning and end of output are informative
 * (e.g., test runner output: header + summary).
 */
export function truncateMiddle(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS
): string {
  if (text.length <= maxChars) return text;
  const halfKeep = Math.floor((maxChars - ELLIPSIS.length) / 2);
  if (halfKeep <= 0) return text.slice(0, maxChars);
  return text.slice(0, halfKeep) + ELLIPSIS + text.slice(-halfKeep);
}

/**
 * Smart truncation for tool output: applies the most appropriate
 * truncation strategy based on content characteristics.
 *
 * - If content has many lines, truncate by lines first
 * - Then apply character-level truncation if still too large
 */
export function truncateToolOutput(
  output: string,
  options: {
    maxChars?: number;
    maxLines?: number;
    strategy?: "head" | "tail" | "middle";
  } = {}
): string {
  const {
    maxChars = DEFAULT_MAX_CHARS,
    maxLines = 500,
    strategy = "tail"
  } = options;

  // First pass: line truncation
  let result = truncateLines(output, maxLines);

  // Second pass: character truncation
  if (result.length > maxChars) {
    switch (strategy) {
      case "head":
        result = truncateHead(result, maxChars);
        break;
      case "middle":
        result = truncateMiddle(result, maxChars);
        break;
      case "tail":
      default:
        result = truncateTail(result, maxChars);
        break;
    }
  }

  return result;
}
