/**
 * `enforceRowSizeLimit` is kept only for released packages that import it
 * from `agents/chat`: `@cloudflare/think` 0.21 to 0.24 and
 * `@cloudflare/ai-chat` 0.10 and 0.11 cut a message to fit one row before storing it,
 * and their peer ranges let them install beside this `agents`. Nothing in
 * this repo calls it: Sessions stores a large message whole across rows.
 * Message hygiene itself lives in `agents/sessions`.
 */

import type { UIMessage } from "ai";
import { SQLITE_ROW_BYTES } from "../internal/platform-limits";
import { byteLength, sanitizeMessage } from "../sessions/sanitize";
import { truncateToolOutput } from "./tool-output-truncation";

export { byteLength, sanitizeMessage };

/**
 * The largest serialized message {@link enforceRowSizeLimit} leaves whole.
 *
 * @internal Exported for its tests.
 */
export const ROW_MAX_BYTES = SQLITE_ROW_BYTES - 200_000;

/**
 * Optional hooks for {@link enforceRowSizeLimit}.
 *
 * @internal Kept for released packages (see the top of this file).
 * @deprecated
 */
export interface EnforceRowSizeLimitOptions {
  /**
   * Optional logger invoked when a message has to be compacted/truncated. The
   * package supplies its own log prefix (log prefixes stay package-specific).
   */
  warn?: (message: string) => void;
}

/**
 * Enforce SQLite row size limits by compacting tool outputs and text parts
 * when a serialized message exceeds one row less 200,000 bytes.
 *
 * Compaction strategy:
 * 1. Compact tool outputs over 1KB with {@link truncateToolOutput}, preserving
 *    the structured output shape, and annotate `metadata.compactedToolOutputs`
 *    with the compacted tool-call IDs.
 * 2. If still too big, truncate text parts from oldest to newest, annotating
 *    `metadata.compactedTextParts` with the truncated part indices.
 *
 * @internal Kept for `@cloudflare/think` 0.21 to 0.24 and
 * `@cloudflare/ai-chat` 0.10 and 0.11, which import it; nothing here calls it.
 * @deprecated
 */
export function enforceRowSizeLimit(
  message: UIMessage,
  options?: EnforceRowSizeLimitOptions
): UIMessage {
  let json = JSON.stringify(message);
  let size = byteLength(json);
  if (size <= ROW_MAX_BYTES) return message;

  if (message.role !== "assistant") {
    options?.warn?.(
      `Non-assistant message ${message.id} is ${size} bytes, exceeds row ` +
        `limit. Truncating text parts.`
    );
    return truncateTextParts(message);
  }

  options?.warn?.(
    `Message ${message.id} is ${size} bytes, compacting tool outputs to fit ` +
      `SQLite row limit`
  );

  const compactedToolCallIds: string[] = [];
  const compactedParts = message.parts.map((part) => {
    if (
      "output" in part &&
      "toolCallId" in part &&
      "state" in part &&
      part.state === "output-available"
    ) {
      const output = (part as { output: unknown }).output;
      const truncated = truncateToolOutput(output, 1000);
      if (truncated.truncated) {
        compactedToolCallIds.push(part.toolCallId as string);
        return {
          ...part,
          output: truncated.output
        };
      }
    }
    return part;
  }) as UIMessage["parts"];

  const result: UIMessage = { ...message, parts: compactedParts };
  if (compactedToolCallIds.length > 0) {
    result.metadata = {
      ...(result.metadata ?? {}),
      compactedToolOutputs: compactedToolCallIds
    };
  }

  json = JSON.stringify(result);
  size = byteLength(json);
  if (size <= ROW_MAX_BYTES) return result;

  options?.warn?.(
    `Message ${message.id} still ${size} bytes after tool compaction, ` +
      `truncating text parts`
  );
  return truncateTextParts(result);
}

function truncateTextParts(message: UIMessage): UIMessage {
  const compactedTextPartIndices: number[] = [];
  const parts = [...message.parts];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === "text" && "text" in part) {
      const text = (part as { text: string }).text;
      if (text.length > 1000) {
        compactedTextPartIndices.push(i);
        parts[i] = {
          ...part,
          text:
            `[Text truncated for storage (${text.length} chars). ` +
            `First 500 chars: ${text.slice(0, 500)}...]`
        } as UIMessage["parts"][number];

        const candidate = { ...message, parts };
        if (byteLength(JSON.stringify(candidate)) <= ROW_MAX_BYTES) {
          break;
        }
      }
    }
  }

  const result: UIMessage = { ...message, parts };
  if (compactedTextPartIndices.length > 0) {
    result.metadata = {
      ...(result.metadata ?? {}),
      compactedTextParts: compactedTextPartIndices
    };
  }
  return result;
}
