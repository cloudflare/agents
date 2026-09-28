/**
 * Read-time context truncation.
 *
 * Truncates older tool outputs and long text before sending to the LLM.
 * Does NOT mutate stored messages — operates on a copy.
 *
 * Truncating a UI tool output in place can still break a tool's declared
 * output schema (markers, dropped array items, shortened strings), which a
 * validating `toModelOutput` then rejects on every replay. Callers that pass
 * `tools` to `convertToModelMessages` should set `toolOutputs: false` here and
 * truncate the converted results with {@link truncateOlderToolResults}.
 */

import type { ModelMessage } from "ai";
import { truncatedSuffix, truncateToolOutput } from "./tool-output-truncation";
import type { SessionMessage } from "../sessions/types";

export interface TruncateOptions {
  /** Number of recent messages to keep intact (default: 4) */
  keepRecent?: number;
  /** Max chars for tool outputs in older messages (default: 500) */
  maxToolOutputChars?: number;
  /** Max chars for text parts in older messages (default: 10000) */
  maxTextChars?: number;
  /**
   * Truncate tool outputs in older messages (default: true). Set to `false`
   * to leave them intact and truncate the converted model messages with
   * {@link truncateOlderToolResults} instead.
   */
  toolOutputs?: boolean;
}

/**
 * Truncate tool outputs and long text in older messages.
 * Returns a new array — input messages are not mutated.
 *
 * Recent messages (last `keepRecent`) are left intact.
 * Older messages get tool outputs and long text truncated. Structured tool
 * outputs are truncated in place instead of being replaced by raw strings.
 * Provider-executed tool outputs are never truncated: the provider parses
 * them against its own schema when they are replayed.
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
  const truncateToolOutputs = options?.toolOutputs ?? true;

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
        truncateToolOutputs &&
        isToolPart(part) &&
        "output" in part &&
        !isProviderExecuted(part)
      ) {
        const output = (part as { output?: unknown }).output;
        if (output !== undefined) {
          const truncated = truncateToolOutput(output, maxToolOutput);
          if (truncated.truncated) {
            changed = true;
            return {
              ...part,
              output: truncated.output
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

export interface TruncateToolResultsOptions {
  /** Number of recent UI messages whose tool results stay intact (default: 4) */
  keepRecent?: number;
  /** Max chars for each older tool result (default: 500) */
  maxToolOutputChars?: number;
}

/**
 * Truncate the tool results of older messages after `convertToModelMessages`.
 * `messages` are the UI messages that were converted, so "older" means the
 * same messages {@link truncateOlderMessages} treats as older.
 *
 * The converted result is what the model reads, after any `toModelOutput`, so
 * no tool schema applies to it. Provider-executed results are left intact.
 * Inline file and image bytes in an older `content` result are replaced by a
 * short text marker.
 *
 * Tool call ids are not unique across turns, so each converted result is
 * matched to the UI tool part it came from by order: the Nth result for an id
 * belongs to the Nth UI part with that id that converts to a tool result.
 */
export function truncateOlderToolResults<M extends ModelMessage>(
  modelMessages: M[],
  messages: readonly SessionMessage[],
  options?: TruncateToolResultsOptions
): M[] {
  const keepRecent = options?.keepRecent ?? 4;
  const maxChars = options?.maxToolOutputChars ?? 500;
  const cutoff = messages.length - keepRecent;
  if (cutoff <= 0) return modelMessages;

  // Per tool call id, in transcript order: whether each result it converts
  // to may be truncated.
  const resultsById = new Map<string, boolean[]>();
  let hasOlderResult = false;
  messages.forEach((message, index) => {
    for (const part of message.parts) {
      if (!isToolPart(part) || !producesToolResult(part)) continue;
      const truncatable = index < cutoff && !isProviderExecuted(part);
      const toolCallId = (part as { toolCallId: string }).toolCallId;
      const results = resultsById.get(toolCallId) ?? [];
      results.push(truncatable);
      resultsById.set(toolCallId, results);
      hasOlderResult ||= truncatable;
    }
  });
  if (!hasOlderResult) return modelMessages;

  return modelMessages.map((message) => {
    if (message.role !== "tool") return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      if (!resultsById.get(part.toolCallId)?.shift()) return part;
      const output = truncateModelOutput(part.output, maxChars);
      if (output === part.output) return part;
      changed = true;
      return { ...part, output };
    });
    return changed ? { ...message, content } : message;
  });
}

type ToolResultOutput = Extract<
  Extract<ModelMessage, { role: "tool" }>["content"][number],
  { type: "tool-result" }
>["output"];

function truncateModelOutput(
  output: ToolResultOutput,
  maxChars: number
): ToolResultOutput {
  switch (output.type) {
    case "text":
    case "error-text":
    case "json":
    case "error-json": {
      const truncated = truncateToolOutput(output.value, maxChars);
      return truncated.truncated
        ? ({ ...output, value: truncated.output } as ToolResultOutput)
        : output;
    }
    case "content": {
      type ContentItem = (typeof output.value)[number];
      let changed = false;
      const withoutBytes = output.value.map((item): ContentItem => {
        const mediaType = inlineBinaryMediaType(item);
        if (mediaType === undefined) return item;
        changed = true;
        return { type: "text", text: omittedMediaMarker(mediaType) };
      });
      const total = output.value.reduce(
        (sum, item) => sum + (inlineText(item)?.length ?? 0),
        0
      );
      if (total <= maxChars) {
        return changed ? { ...output, value: withoutBytes } : output;
      }
      // `maxChars` bounds the whole result, so text items share one budget,
      // and room is kept for the marker so a dropped tail is never silent.
      // Markers for omitted bytes are not part of that budget.
      const suffix = truncatedSuffix(total);
      let remaining = Math.max(0, maxChars - suffix.length);
      let truncated = false;
      const value = output.value.flatMap((item, index): ContentItem[] => {
        const text = inlineText(item);
        if (text === undefined) return [withoutBytes[index]];
        if (truncated) return [];
        if (text.length <= remaining) {
          remaining -= text.length;
          return [item];
        }
        truncated = true;
        const cut =
          maxChars <= suffix.length
            ? suffix.slice(0, maxChars)
            : `${text.slice(0, remaining)}${suffix}`;
        return [withInlineText(item, cut)];
      });
      return { ...output, value };
    }
    default:
      return output;
  }
}

type ContentOutputItem = Extract<
  ToolResultOutput,
  { type: "content" }
>["value"][number];

/** Text a content item carries inline: a text item, or a text file. */
function inlineText(item: ContentOutputItem): string | undefined {
  if (item.type === "text") return item.text;
  if (item.type === "file" && item.data.type === "text") return item.data.text;
  return undefined;
}

function withInlineText(
  item: ContentOutputItem,
  text: string
): ContentOutputItem {
  if (item.type === "file" && item.data.type === "text") {
    return { ...item, data: { ...item.data, text } };
  }
  return { ...item, text } as ContentOutputItem;
}

/** Media type of a content item that carries file or image bytes inline. */
function inlineBinaryMediaType(item: ContentOutputItem): string | undefined {
  if (item.type === "file-data" || item.type === "image-data") {
    return item.mediaType;
  }
  if (item.type === "file" && item.data.type === "data") return item.mediaType;
  return undefined;
}

function omittedMediaMarker(mediaType: string): string {
  return `[${mediaType} omitted from an older tool result]`;
}

/**
 * Whether `convertToModelMessages` turns this UI tool part into a result in a
 * `tool` message. Provider-executed results go in the assistant message
 * instead, unless the part is a denied approval.
 */
function producesToolResult(part: object): boolean {
  const { state, approval } = part as {
    state?: unknown;
    approval?: { approved?: unknown };
  };
  if (state === "approval-responded") return approval?.approved === false;
  if (isProviderExecuted(part)) return false;
  return (
    state === "output-available" ||
    state === "output-error" ||
    state === "output-denied"
  );
}

function isToolPart(part: { type: string }): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

function isProviderExecuted(part: object): boolean {
  return (part as { providerExecuted?: unknown }).providerExecuted === true;
}
