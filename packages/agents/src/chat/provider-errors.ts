/**
 * What a model provider's error means for a chat turn, read from the error
 * itself: the `agents/models` error (`CloudflareAIError`, core or AI SDK), an
 * AI SDK `APICallError`, or any error with an HTTP status and a message.
 *
 * Both hosts ask the app's `classifyChatError` hook first (Think) and fall
 * back to this when it gives no answer, so the hook always wins.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

/** What a provider error means for the turn. */
export type ProviderErrorClassification =
  | "context_overflow"
  | "rate_limit"
  | "transient";

/**
 * The context-window errors of the common providers (Anthropic, OpenAI,
 * Google, Bedrock, Mistral, Workers AI). Favours recall: a false positive
 * retries once and fails the same way.
 *
 * @internal
 */
export const CONTEXT_OVERFLOW_PATTERN =
  /prompt is too long|context[_ ]length[_ ]exceeded|maximum context length|exceeds the maximum number of tokens|input token count|reduce the length of|input is too long|too many (?:input )?tokens|context window/i;

/** The HTTP status an error carries, if any. */
function statusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const record = error as { status?: unknown; statusCode?: unknown };
  const status = record.statusCode ?? record.status;
  return typeof status === "number" ? status : undefined;
}

/** The text an error says, its response body included. */
function textOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const body = (error as { responseBody?: unknown }).responseBody;
    return typeof body === "string"
      ? `${error.message}\n${body}`
      : error.message;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * What a provider's error means for the turn, or `undefined` when it says
 * nothing the turn can act on.
 *
 * - a context-window error (by its text, at a 400 or 413 or with no status)
 *   is `context_overflow`;
 * - a 429 is `rate_limit`;
 * - a 408, 5xx or 529, or an in-stream "overloaded" error with no status,
 *   is `transient`.
 *
 * An AI SDK `RetryError` (its retries ran out) is read by its last error.
 *
 * @internal
 */
export function classifyProviderError(
  error: unknown
): ProviderErrorClassification | undefined {
  const last =
    error !== null && typeof error === "object" && "lastError" in error
      ? (error as { lastError: unknown }).lastError
      : undefined;
  if (last !== undefined) return classifyProviderError(last);
  const status = statusOf(error);
  const text = status === undefined || status < 500 ? textOf(error) : "";
  if (
    (status === undefined || status === 400 || status === 413) &&
    CONTEXT_OVERFLOW_PATTERN.test(text)
  ) {
    return "context_overflow";
  }
  if (status === 429) return "rate_limit";
  if (
    status === 408 ||
    (status !== undefined && status >= 500) ||
    (status === undefined && /overloaded/i.test(text))
  ) {
    return "transient";
  }
  return undefined;
}
