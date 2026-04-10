/**
 * Read-time context truncation.
 *
 * Truncates older tool outputs and long text before sending to the LLM.
 * Does NOT mutate stored messages — operates on a copy.
 */

import type { SessionMessage } from "../session/types";

export interface TruncateOptions {
  /** Number of recent messages to keep intact (default: 4) */
  keepRecent?: number;
  /** Max chars for tool outputs in older messages (default: 500) */
  maxToolOutputChars?: number;
  /** Max chars for text parts in older messages (default: 10000) */
  maxTextChars?: number;
}

/**
 * Truncate tool outputs and long text in older messages.
 * Returns a new array — input messages are not mutated.
 *
 * Recent messages (last `keepRecent`) are left intact.
 * Older messages get tool outputs and long text truncated.
 *
 * Use in assembleContext() before sending to the LLM:
 * ```typescript
 * async assembleContext() {
 *   const history = this.sessions.getHistory(this._sessionId);
 *   const truncated = truncateOlderMessages(history);
 *   return convertToModelMessages(truncated);
 * }
 * ```
 */
export function truncateOlderMessages(
  messages: SessionMessage[],
  options?: TruncateOptions
): SessionMessage[] {
  const keepRecent = options?.keepRecent ?? 4;
  const maxToolOutput = options?.maxToolOutputChars ?? 500;
  const maxText = options?.maxTextChars ?? 10000;

  if (messages.length <= keepRecent) return messages;

  const cutoff = messages.length - keepRecent;
  const result: SessionMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (i >= cutoff) {
      result.push(messages[i]);
      continue;
    }

    const msg = messages[i];
    let changed = false;

    const truncatedParts = msg.parts.map((part) => {
      // Truncate tool outputs
      if (
        (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
        "output" in part
      ) {
        const output = (part as { output?: unknown }).output;
        if (output !== undefined) {
          const str =
            typeof output === "string" ? output : JSON.stringify(output);
          if (str.length > maxToolOutput) {
            changed = true;
            return {
              ...part,
              output: `${str.slice(0, maxToolOutput)}... [truncated ${str.length} chars]`
            };
          }
        }
      }

      // Truncate long text
      if (part.type === "text" && "text" in part) {
        const text = (part as { text: string }).text;
        if (text.length > maxText) {
          changed = true;
          return {
            ...part,
            text: `${text.slice(0, maxText)}... [truncated ${text.length} chars]`
          };
        }
      }

      return part;
    });

    result.push(
      changed ? ({ ...msg, parts: truncatedParts } as SessionMessage) : msg
    );
  }

  return result;
}
