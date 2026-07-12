import { defaultIdSource } from "../../kernel/ids.js";
import type { ModelMessage } from "../../ports/model.js";

export type { ModelMessage } from "../../ports/model.js";

export type Role = "system" | "user" | "assistant";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "file"; mediaType: string; url?: string; data?: string; filename?: string }
  | ToolPart;

export type ToolPart = {
  type: `tool-${string}`;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "approval-requested" | "output-available" | "output-error";
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
};

export interface ChatMessage {
  id: string;
  role: Role;
  parts: MessagePart[];
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export function isToolPart(part: MessagePart): part is ToolPart {
  return part.type.startsWith("tool-");
}

/** Strips the "tool-" prefix, e.g. "tool-search" -> "search". */
export function toolName(part: ToolPart): string {
  return part.type.slice("tool-".length);
}

export function textOf(message: ChatMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export function userMessage(text: string, id?: string): ChatMessage {
  return {
    id: id ?? defaultIdSource.newId("msg"),
    role: "user",
    parts: [{ type: "text", text }],
  };
}

export function assistantMessage(parts: MessagePart[], id?: string): ChatMessage {
  return {
    id: id ?? defaultIdSource.newId("msg"),
    role: "assistant",
    parts,
  };
}

/**
 * Converts persisted ChatMessages into provider-facing ModelMessages.
 *
 * Rules:
 * - Reasoning parts are dropped.
 * - An assistant message's settled tool parts (output-available /
 *   output-error) expand into an assistant message (tool-calls) followed by
 *   a tool message (tool-results).
 * - Tool parts still awaiting input/approval produce no tool-call (they must
 *   be repaired first).
 * - Empty messages (no convertible parts) are omitted.
 */
export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = textOf(message);
      if (text.length > 0) {
        result.push({ role: "system", content: text });
      }
      continue;
    }

    if (message.role === "user") {
      const content: Array<{ type: "text"; text: string } | { type: "file"; mediaType: string; data: string }> = [];
      for (const part of message.parts) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "file" && part.data !== undefined) {
          content.push({ type: "file", mediaType: part.mediaType, data: part.data });
        }
      }
      if (content.length > 0) {
        result.push({ role: "user", content });
      }
      continue;
    }

    // assistant
    const assistantContent: Array<
      { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
    > = [];
    const toolResults: Array<{
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError?: boolean;
    }> = [];

    for (const part of message.parts) {
      if (part.type === "text") {
        assistantContent.push({ type: "text", text: part.text });
      } else if (isToolPart(part)) {
        if (part.state === "output-available" || part.state === "output-error") {
          const name = toolName(part);
          assistantContent.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: name,
            input: part.input,
          });
          if (part.state === "output-error") {
            toolResults.push({
              type: "tool-result",
              toolCallId: part.toolCallId,
              toolName: name,
              output: part.errorText,
              isError: true,
            });
          } else {
            toolResults.push({
              type: "tool-result",
              toolCallId: part.toolCallId,
              toolName: name,
              output: part.output,
            });
          }
        }
        // input-streaming / input-available / approval-requested: excluded.
      }
      // reasoning / file parts on assistant messages: dropped.
    }

    if (assistantContent.length > 0) {
      result.push({ role: "assistant", content: assistantContent });
    }
    if (toolResults.length > 0) {
      result.push({ role: "tool", content: toolResults });
    }
  }

  return result;
}
