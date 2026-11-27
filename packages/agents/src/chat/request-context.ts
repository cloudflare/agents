import { ROW_VALUE_BYTES, utf8Length } from "../internal/platform-limits";

/**
 * The session value the last request context is kept in. Under
 * `transcript:`, so a chat clear drops it.
 *
 * @internal
 */
export const CHAT_REQUEST_CONTEXT_KEY = "transcript:chat:request";

/**
 * `json` when it fits one row (`ROW_VALUE_BYTES`), else `null` with a
 * warning: a request context that large is kept in memory only.
 *
 * @internal
 */
export function storableRequestContext(json: string | null): string | null {
  if (json === null || json.length * 3 <= ROW_VALUE_BYTES) return json;
  if (utf8Length(json) <= ROW_VALUE_BYTES) return json;
  console.warn(
    `[agents/chat] The last request's client tools and body (${json.length} characters) are over the ${ROW_VALUE_BYTES}-byte row budget, so they are kept in memory only: after a restart, a server-started turn runs without them.`
  );
  return null;
}
