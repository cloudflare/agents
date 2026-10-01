import type {
  AssistantMessage,
  Message,
  UserMessage
} from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { PiMessage, PiMessagePart } from "./types";

function userParts(content: UserMessage["content"]): PiMessagePart[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
}

function assistantParts(content: AssistantMessage["content"]): PiMessagePart[] {
  return content.map((part): PiMessagePart => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "thinking":
        return { type: "thinking", text: part.thinking };
      case "toolCall":
        return {
          type: "tool-call",
          id: part.id,
          name: part.name,
          arguments: part.arguments
        };
    }
  });
}

/** Project one pi-ai message. */
export function projectMessage(message: Message, id: string): PiMessage {
  switch (message.role) {
    case "system":
      // pi records prompt changes as system entries; the UI does not show them.
      return { id, role: "notice", parts: [], timestamp: 0 };
    case "user":
      return {
        id,
        role: "user",
        parts: userParts(message.content),
        timestamp: message.timestamp
      };
    case "assistant":
      return {
        id,
        role: "assistant",
        parts: assistantParts(message.content),
        timestamp: message.timestamp,
        stopReason: message.stopReason,
        ...(message.errorMessage === undefined
          ? {}
          : { error: message.errorMessage })
      };
    case "toolResult":
      return {
        id,
        role: "tool",
        parts: [
          {
            type: "tool-result",
            id: message.toolCallId,
            name: message.toolName,
            content: message.content,
            ...(message.details === undefined
              ? {}
              : { details: message.details }),
            error: message.isError
          }
        ],
        timestamp: message.timestamp
      };
  }
}

/**
 * Project one transcript entry. Entries that carry a model message become
 * that message; a reset becomes a notice; system-prompt entries and other
 * bookkeeping have no projection.
 */
export function projectEntry(entry: EntryRecord): PiMessage | undefined {
  const message = entry.model?.[0];
  if (entry.kind === "pi.reset") {
    return {
      id: String(entry.id),
      role: "notice",
      parts: [{ type: "text", text: "Context reset" }],
      timestamp: 0
    };
  }
  if (entry.kind === "pi.system" || message === undefined) return undefined;
  return projectMessage(message, String(entry.id));
}

export function projectEntries(entries: readonly EntryRecord[]): PiMessage[] {
  return entries.flatMap((entry) => {
    const message = projectEntry(entry);
    return message ? [message] : [];
  });
}

/** The text of an assistant entry, for results. */
export function assistantText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.[0];
  if (message?.role !== "assistant") return "";
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}
