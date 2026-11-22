/**
 * Truncation of the payloads of tool calls a provider ran on its own side
 * (Anthropic `code_execution` and `text_editor`, for example). Their
 * `input` and `output` can run to hundreds of kilobytes and the model has
 * already read them, so the stored copy keeps a short prefix.
 */

/**
 * Fields whose values are opaque replay tokens: stored exactly as the
 * provider returned them.
 */
const OPAQUE_STRING_KEY_PREFIX = "encrypted";

/**
 * Longest string kept in the `input` or `output` of a provider-executed
 * tool part. A longer one is cut, with a marker giving its length.
 *
 * @internal
 */
export const PROVIDER_TOOL_MAX_STRING_LENGTH = 500;

/**
 * Cut long strings in the `input` and `output` of a provider-executed tool
 * part. Other parts are returned unchanged, and so are the web tools
 * (`web_search`, `web_fetch`) whose outputs are replayed on later turns.
 * Strings under an opaque key (`encrypted…`) are kept whole. Running it on
 * its own output changes nothing.
 *
 * @internal
 */
export function truncateProviderToolPayloads<T extends object>(part: T): T {
  const record = part as Record<string, unknown>;
  if (!record.providerExecuted) return part;
  const toolName = toolNameOf(record);
  if (toolName === "web_search" || toolName === "web_fetch") return part;

  const result = { ...record };
  if (result.input !== undefined) {
    result.input = truncateLargeStrings(result.input);
  }
  if (result.output !== undefined) {
    result.output = truncateLargeStrings(result.output);
  }
  return result as T;
}

function truncateLargeStrings(value: unknown, keepStrings = false): unknown {
  if (typeof value === "string") {
    if (keepStrings || value.length <= PROVIDER_TOOL_MAX_STRING_LENGTH) {
      return value;
    }
    // Marker included, the result stays within the limit, so a second pass
    // leaves it alone.
    const marker = `… [truncated, original length: ${value.length}]`;
    const keep = Math.max(0, PROVIDER_TOOL_MAX_STRING_LENGTH - marker.length);
    return value.slice(0, keep) + marker;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateLargeStrings(item, keepStrings));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = truncateLargeStrings(
        item,
        keepStrings || key.startsWith(OPAQUE_STRING_KEY_PREFIX)
      );
    }
    return result;
  }
  return value;
}

function toolNameOf(part: Record<string, unknown>): string | undefined {
  if (typeof part.toolName === "string") return part.toolName;
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    return part.type.slice("tool-".length);
  }
  return undefined;
}
