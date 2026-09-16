import type {
  AgentMessage,
  AgentToolResult,
  Entry,
  LaneQueuedItem
} from "@earendil-works/pi-agent-core";
import type { SessionMessage, SessionMessagePart } from "agents/sessions";
import type {
  PiJson,
  PiMessage,
  PiMessagePart,
  PiQueuedItem,
  PiToolContent,
  PiToolResult
} from "./types";

/**
 * Pi carries tool arguments and details as JSON it parsed or a tool returned;
 * the projection names that contract without re-validating every value.
 */
function asJson(value: unknown): PiJson {
  return value as PiJson;
}

type UserContent = Extract<AgentMessage, { role: "user" }>["content"];
type AssistantContent = Extract<AgentMessage, { role: "assistant" }>["content"];

function userParts(content: UserContent): PiMessagePart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", data: part.data, mimeType: part.mimeType }
  );
}

function assistantParts(content: AssistantContent): PiMessagePart[] {
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
          arguments: asJson(part.arguments)
        };
    }
  });
}

function timestampOf(message: AgentMessage, fallback: number): number {
  return "timestamp" in message && typeof message.timestamp === "number"
    ? message.timestamp
    : fallback;
}

/**
 * Project one pi message into the stable public shape. Custom message roles
 * that pi keeps for its own bookkeeping have no display projection.
 */
export function projectAgentMessage(
  message: AgentMessage,
  id: string,
  fallbackTimestamp = Date.now()
): PiMessage | undefined {
  const timestamp = timestampOf(message, fallbackTimestamp);
  switch (message.role) {
    case "user":
      return { id, role: "user", parts: userParts(message.content), timestamp };
    case "assistant":
      return {
        id,
        role: "assistant",
        parts: assistantParts(message.content),
        timestamp,
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
              : { details: asJson(message.details) }),
            error: message.isError
          }
        ],
        timestamp
      };
    default:
      return undefined;
  }
}

/** Project one transcript entry; non-message entries have no projection. */
export function projectEntry(entry: Entry): PiMessage | undefined {
  if (entry.type !== "message") return undefined;
  return projectAgentMessage(entry.message, entry.id, entry.timestamp);
}

/** Project pi's internal entries into the stable public message shape. */
export function projectMessages(entries: readonly Entry[]): PiMessage[] {
  return entries.flatMap((entry) => {
    const message = projectEntry(entry);
    return message ? [message] : [];
  });
}

/** Project a partial or final tool result. */
export function projectToolResult(
  result: AgentToolResult<unknown>
): PiToolResult {
  return {
    content: result.content,
    details: asJson(result.details),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.addedToolNames === undefined
      ? {}
      : { addedToolNames: result.addedToolNames }),
    ...(result.terminate === undefined ? {} : { terminate: result.terminate })
  };
}

/** Project a lane's queued inbox items. */
export function projectQueue(items: readonly LaneQueuedItem[]): PiQueuedItem[] {
  return items.map((item) => {
    if (item.type !== "message") {
      return { entryId: item.entryId, kind: item.kind };
    }
    const message = projectAgentMessage(item.message, item.entryId);
    return {
      entryId: item.entryId,
      kind: item.kind,
      ...(message === undefined ? {} : { message })
    };
  });
}

/** Flatten a tool result's content into the text a transcript shows. */
function contentText(content: readonly PiToolContent[]): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

/**
 * Project one pi message part onto the shared `SessionMessagePart` shape, so
 * every harness renders the same transcript whatever ran the loop. Pi's own
 * extras (a tool result's structured details, an image's bytes) ride the
 * fields the shape already has.
 */
export function toSessionParts(
  parts: readonly PiMessagePart[]
): SessionMessagePart[] {
  return parts.map((part): SessionMessagePart => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "thinking":
        return { type: "reasoning", text: part.text };
      case "image":
        return {
          type: "file",
          mediaType: part.mimeType,
          url: `data:${part.mimeType};base64,${part.data}`
        };
      case "tool-call":
        return {
          type: "tool-call",
          toolCallId: part.id,
          toolName: part.name,
          input: part.arguments
        };
      case "tool-result":
        return {
          type: "tool-result",
          toolCallId: part.id,
          toolName: part.name,
          output: contentText(part.content),
          ...(part.details === undefined ? {} : { result: part.details }),
          state: part.error ? "output-error" : "output-available"
        };
    }
  });
}

/** Project one pi message onto the shared transcript shape. */
export function toSessionMessage(message: PiMessage): SessionMessage {
  return {
    id: message.id,
    role: message.role,
    parts: toSessionParts(message.parts)
  };
}
