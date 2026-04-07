/**
 * Protocol Message Parser — typed parsing of cf_agent_chat_* WebSocket messages.
 *
 * Parses raw WebSocket messages into a discriminated union of protocol events.
 * Both AIChatAgent and Think can use this instead of manual JSON.parse + type checking.
 */

import { CHAT_MESSAGE_TYPES } from "./protocol";

/**
 * Discriminated union of all incoming chat protocol events.
 *
 * Each agent handles the events it cares about and ignores the rest.
 * Returns `null` for non-JSON messages or unrecognized types.
 */
export type ChatProtocolEvent =
  | {
      type: "chat-request";
      id: string;
      init: { method?: string; body?: string; [key: string]: unknown };
    }
  | { type: "clear" }
  | { type: "cancel"; id: string }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: unknown;
      state?: string;
      errorText?: string;
      autoContinue?: boolean;
      clientTools?: Array<{
        name: string;
        description?: string;
        parameters?: unknown;
      }>;
    }
  | {
      type: "tool-approval";
      toolCallId: string;
      approved: boolean;
      autoContinue?: boolean;
    }
  | { type: "stream-resume-request" }
  | { type: "stream-resume-ack"; id: string }
  | { type: "messages"; messages: unknown[] };

/**
 * Parse a raw WebSocket message string into a typed protocol event.
 *
 * Returns `null` if the message is not valid JSON or not a recognized
 * protocol message type. Callers should fall through to the user's
 * `onMessage` handler when `null` is returned.
 *
 * @example
 * ```typescript
 * const event = parseProtocolMessage(rawMessage);
 * if (!event) return userOnMessage(connection, rawMessage);
 *
 * switch (event.type) {
 *   case "chat-request": { ... }
 *   case "clear": { ... }
 *   case "tool-result": { ... }
 * }
 * ```
 */
export function parseProtocolMessage(raw: string): ChatProtocolEvent | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const wireType = data.type as string | undefined;
  if (!wireType) return null;

  switch (wireType) {
    case CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST:
      return {
        type: "chat-request",
        id: data.id as string,
        init: (data.init as { method?: string; body?: string }) ?? {}
      };

    case CHAT_MESSAGE_TYPES.CHAT_CLEAR:
      return { type: "clear" };

    case CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL:
      return { type: "cancel", id: data.id as string };

    case CHAT_MESSAGE_TYPES.TOOL_RESULT:
      return {
        type: "tool-result",
        toolCallId: data.toolCallId as string,
        toolName: (data.toolName as string) ?? "",
        output: data.output,
        state: data.state as string | undefined,
        errorText: data.errorText as string | undefined,
        autoContinue: data.autoContinue as boolean | undefined,
        clientTools: data.clientTools as
          | Array<{
              name: string;
              description?: string;
              parameters?: unknown;
            }>
          | undefined
      };

    case CHAT_MESSAGE_TYPES.TOOL_APPROVAL:
      return {
        type: "tool-approval",
        toolCallId: data.toolCallId as string,
        approved: data.approved as boolean,
        autoContinue: data.autoContinue as boolean | undefined
      };

    case CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST:
      return { type: "stream-resume-request" };

    case CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK:
      return { type: "stream-resume-ack", id: data.id as string };

    case CHAT_MESSAGE_TYPES.CHAT_MESSAGES:
      return {
        type: "messages",
        messages: (data.messages as unknown[]) ?? []
      };

    default:
      return null;
  }
}
