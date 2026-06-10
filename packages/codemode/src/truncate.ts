/**
 * Result truncation utilities.
 *
 * Tool and sandbox results can be large enough to blow a model's context
 * window. These cap the serialized size of a value while leaving small,
 * structured results intact so the model can still reason over them. They are
 * the default building blocks for a `transformResult` hook (see
 * `createCodemodeRuntime`).
 */

/** ~4 characters per token is a reasonable cross-model estimate. */
const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 6000;
const TRUNCATION_MARKER = "--- TRUNCATED ---";

export type TruncateOptions = {
  /**
   * Maximum characters in the (serialized) output before truncation kicks in.
   * Defaults to `maxTokens * 4`.
   */
  maxChars?: number;
  /** Token budget used to derive the default `maxChars`. Defaults to 6000. */
  maxTokens?: number;
};

function budget(options?: TruncateOptions): {
  maxChars: number;
  maxTokens: number;
} {
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxChars = options?.maxChars ?? maxTokens * CHARS_PER_TOKEN;
  return { maxChars, maxTokens };
}

/**
 * Truncate a text response to a character budget, appending a marker that notes
 * the original size so the model knows the output was clipped. Returns the
 * input unchanged when it is within budget.
 */
export function truncateResponse(
  text: string,
  options?: TruncateOptions
): string {
  const { maxChars, maxTokens } = budget(options);
  if (text.length <= maxChars) return text;

  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
  return (
    text.slice(0, maxChars) +
    `\n\n${TRUNCATION_MARKER}\nResponse was ~${estimatedTokens.toLocaleString()} tokens ` +
    `(limit: ${maxTokens.toLocaleString()}). Narrow the request to reduce response size.`
  );
}

/**
 * Truncate a structured result. Strings are truncated directly. Other values
 * pass through unchanged when their JSON serialization is within budget; when
 * oversized, the serialized form is truncated and returned as a string, so the
 * model still gets a usable, bounded preview rather than a dropped result.
 *
 * Values that can't be serialized (cycles, bigint, `undefined`) are returned
 * unchanged.
 */
export function truncateResult(
  value: unknown,
  options?: TruncateOptions
): unknown {
  if (typeof value === "string") return truncateResponse(value, options);

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    return value;
  }
  if (serialized === undefined) return value;

  const { maxChars } = budget(options);
  if (serialized.length <= maxChars) return value;
  return truncateResponse(serialized, options);
}
