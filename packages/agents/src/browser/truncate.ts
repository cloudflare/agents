const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 6000;
const MAX_CHARS = CHARS_PER_TOKEN * MAX_TOKENS;

export function truncateResponse(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : (JSON.stringify(content, null, 2) ?? "null");
  if (text.length <= MAX_CHARS) {
    return text;
  }

  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
  return `${text.slice(0, MAX_CHARS)}\n\n--- TRUNCATED ---\nResponse was ~${estimatedTokens.toLocaleString()} tokens (limit: ${MAX_TOKENS.toLocaleString()}). Use more specific queries to reduce response size.`;
}
