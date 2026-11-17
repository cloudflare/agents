import type {
  AssistantMessage,
  ImageContent,
  JsonValue,
  Message,
  TextContent,
  UserMessage
} from "@earendil-works/pi-ai";
import type { EntryId, EntryRecord } from "@earendil-works/pi-durable";

/**
 * This app's display model for a transcript. The harness returns pi's own
 * entries; the UI projects them into these messages, on the server and in
 * the browser.
 */
export type PiMessagePart =
  | TextContent
  | ImageContent
  | { readonly type: "thinking"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly arguments: JsonValue;
    }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly content: readonly (TextContent | ImageContent)[];
      readonly details?: JsonValue;
      readonly error: boolean;
    };

/**
 * One display-ready row of the transcript: a message projected from a pi
 * entry, or a gap where the client is missing entries.
 *
 * - `notice`: a line such as "Context reset".
 * - `summary`: a compaction summary; the model reads it in place of the
 *   messages before it, and the UI shows a small notice that can show it.
 * - `gap`: entries the client missed between two it has, after a stall or a
 *   reconnect. The UI offers to load them (`ConversationTranscript.fillGap`).
 */
export type PiMessage =
  | {
      /** The pi entry id, or `live` for the message being streamed. */
      readonly id: string;
      readonly role: "user" | "assistant" | "tool" | "notice" | "summary";
      readonly parts: readonly PiMessagePart[];
      readonly timestamp: number;
      readonly stopReason?: string;
      readonly error?: string;
    }
  | {
      readonly id: string;
      readonly role: "gap";
      readonly parts: readonly [];
      readonly timestamp: 0;
      /** The missing entries' ids lie strictly between these two. */
      readonly after: EntryId;
      readonly upTo: EntryId;
    };

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
 * pi gives the model a compaction summary as a user message that wraps the
 * summary in `<summary>` tags; this is the summary inside them.
 */
function summaryText(message: Message | undefined): string {
  if (message?.role !== "user") return "";
  const text = userParts(message.content)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  const wrapped = /<summary>\n?([\s\S]*?)\n?<\/summary>\s*$/.exec(text);
  return wrapped ? wrapped[1] : text;
}

/**
 * Project one transcript entry. Entries that carry a model message become
 * that message; a reset becomes a notice and a compaction a summary;
 * system-prompt entries and other bookkeeping have no projection.
 */
export function projectEntry(entry: EntryRecord): PiMessage | undefined {
  const message = entry.model?.[0];
  if (entry.kind === "pi.compaction") {
    return {
      id: String(entry.id),
      role: "summary",
      parts: [{ type: "text", text: summaryText(message) }],
      timestamp: message?.timestamp ?? 0
    };
  }
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

/** Project entries, such as `session.messages()`, the active context. */
export function projectEntries(entries: readonly EntryRecord[]): PiMessage[] {
  return entries.flatMap((entry) => {
    const message = projectEntry(entry);
    return message ? [message] : [];
  });
}
