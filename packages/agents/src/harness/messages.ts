import type { AgentMessage, Entry } from "pi-agent-core-dev";
import type { PiMessage, PiMessagePart } from "./types";

function userParts(
  content: Extract<AgentMessage, { role: "user" }>["content"]
): PiMessagePart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "image",
          data: part.data,
          mimeType: part.mimeType
        }
  );
}

function assistantParts(
  content: Extract<AgentMessage, { role: "assistant" }>["content"]
): PiMessagePart[] {
  return content.map((part) => {
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

function projectMessage(entry: Entry): PiMessage | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message;
  switch (message.role) {
    case "user":
      return {
        id: entry.id,
        role: "user",
        parts: userParts(message.content),
        timestamp: entry.timestamp
      };
    case "assistant":
      return {
        id: entry.id,
        role: "assistant",
        parts: assistantParts(message.content),
        timestamp: entry.timestamp,
        stopReason: message.stopReason,
        ...(message.errorMessage === undefined
          ? {}
          : { error: message.errorMessage })
      };
    case "toolResult":
      return {
        id: entry.id,
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
        timestamp: entry.timestamp
      };
    default:
      return undefined;
  }
}

/** Project pi's internal entries into the stable public message shape. */
export function projectMessages(entries: readonly Entry[]): PiMessage[] {
  return entries.flatMap((entry) => {
    const message = projectMessage(entry);
    return message ? [message] : [];
  });
}
