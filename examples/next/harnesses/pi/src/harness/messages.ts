import type {
  AgentMessage,
  AgentToolResult,
  Entry,
  LaneQueuedItem
} from "@earendil-works/pi-agent-core";
import type { AssistantMessageFrame } from "@earendil-works/pi-ai";
import type {
  PiJson,
  PiMessage,
  PiMessageDelta,
  PiMessagePart,
  PiQueuedItem,
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

/** Project pi's compact assistant frame into the public delta shape. */
export function projectFrame(
  frame: AssistantMessageFrame,
  messageId: string
): PiMessageDelta | undefined {
  switch (frame.type) {
    case "start": {
      const message = projectAgentMessage(frame.partial, messageId);
      return message ? { type: "start", message } : undefined;
    }
    case "text_start":
      return {
        type: "text_start",
        index: frame.contentIndex,
        text: frame.content.text
      };
    case "text_delta":
      return {
        type: "text_delta",
        index: frame.contentIndex,
        delta: frame.delta
      };
    case "text_end":
      return {
        type: "text_end",
        index: frame.contentIndex,
        text: frame.content
      };
    case "thinking_start":
      return {
        type: "thinking_start",
        index: frame.contentIndex,
        text: frame.content.thinking
      };
    case "thinking_delta":
      return {
        type: "thinking_delta",
        index: frame.contentIndex,
        delta: frame.delta
      };
    case "thinking_end":
      return {
        type: "thinking_end",
        index: frame.contentIndex,
        text: frame.content
      };
    case "toolcall_start":
      return {
        type: "toolcall_start",
        index: frame.contentIndex,
        id: frame.toolCall.id,
        name: frame.toolCall.name,
        arguments: asJson(frame.toolCall.arguments)
      };
    case "toolcall_checkpoint":
      return {
        type: "toolcall_checkpoint",
        index: frame.contentIndex,
        json: frame.json
      };
    case "toolcall_delta":
      return {
        type: "toolcall_delta",
        index: frame.contentIndex,
        delta: frame.delta
      };
    case "toolcall_end":
      return {
        type: "toolcall_end",
        index: frame.contentIndex,
        id: frame.id,
        name: frame.name,
        arguments: asJson(frame.arguments)
      };
  }
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
