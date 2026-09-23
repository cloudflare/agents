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
import { truncateToolOutput } from "./tool-output-truncation";
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

  const olderToolCallIds = new Set<string>();
  for (const message of messages.slice(0, cutoff)) {
    for (const part of message.parts) {
      if (isToolPart(part) && !isProviderExecuted(part)) {
        olderToolCallIds.add((part as { toolCallId: string }).toolCallId);
      }
    }
  }
  if (olderToolCallIds.size === 0) return modelMessages;

  return modelMessages.map((message) => {
    if (message.role !== "tool") return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result" || !olderToolCallIds.has(part.toolCallId))
        return part;
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
      // `maxChars` bounds the whole result, so text items share one budget.
      let remaining = maxChars;
      let changed = false;
      type ContentItem = (typeof output.value)[number];
      const value = output.value.flatMap((item): ContentItem[] => {
        if (item.type !== "text") return [item];
        if (item.text.length <= remaining) {
          remaining -= item.text.length;
          return [item];
        }
        changed = true;
        if (remaining <= 0) return [];
        const truncated = truncateToolOutput(item.text, remaining);
        remaining = 0;
        return [{ ...item, text: truncated.output as string }];
      });
      return changed ? { ...output, value } : output;
    }
    default:
      return output;
  }
}

function isToolPart(part: { type: string }): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

function isProviderExecuted(part: object): boolean {
  return (part as { providerExecuted?: unknown }).providerExecuted === true;
}
