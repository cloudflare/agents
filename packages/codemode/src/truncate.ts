export const CHARS_PER_TOKEN = 4;
export const MAX_TOKENS = 6000;
export const MAX_CHARS = CHARS_PER_TOKEN * MAX_TOKENS;

export const TRUNCATION_MARKER = "--- TRUNCATED ---";
export const TRUNCATION_FOOTER_PREFIX = `\n\n${TRUNCATION_MARKER}\nResponse was ~`;
export const MAX_SANDBOX_TRUNCATED_CHARS = MAX_CHARS + 512;

/**
 * Convert any value to text and cap it for text-only tool result surfaces.
 */
export function truncateResponse(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : (JSON.stringify(content, null, 2) ?? "undefined");
  if (text.length <= MAX_CHARS) {
    return text;
  }

  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
  return `${text.slice(0, MAX_CHARS)}\n\n${TRUNCATION_MARKER}\nResponse was ~${estimatedTokens.toLocaleString()} tokens (limit: ${MAX_TOKENS.toLocaleString()}). Use more specific queries to reduce response size.`;
}

/**
 * Preserve structured values unless they exceed the response limit.
 */
export function truncateResult(content: unknown): unknown {
  const text =
    typeof content === "string"
      ? content
      : (JSON.stringify(content, null, 2) ?? "undefined");
  return text.length <= MAX_CHARS ? content : truncateResponse(content);
}

/**
 * Format sandbox output as text without truncating already-truncated results again.
 */
export function sandboxResponseText(content: unknown): string {
  if (
    typeof content === "string" &&
    content.length <= MAX_SANDBOX_TRUNCATED_CHARS &&
    content.slice(MAX_CHARS).startsWith(TRUNCATION_FOOTER_PREFIX)
  ) {
    return content;
  }
  return truncateResponse(content);
}
