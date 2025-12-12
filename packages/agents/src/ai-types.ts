import type { UIMessage } from "ai";

/**
 * Protocol constants for human-in-the-loop tool confirmation.
 * These strings are sent between client and server to signal user approval/denial.
 */
export const TOOL_CONFIRMATION = {
  APPROVED: "Yes, confirmed.",
  DENIED: "No, denied."
} as const;

export type ToolConfirmationSignal =
  (typeof TOOL_CONFIRMATION)[keyof typeof TOOL_CONFIRMATION];

/** Message types for client-server communication */
export enum MessageType {
  CF_AGENT_CHAT_MESSAGES = "cf_agent_chat_messages",
  CF_AGENT_USE_CHAT_REQUEST = "cf_agent_use_chat_request",
  CF_AGENT_USE_CHAT_RESPONSE = "cf_agent_use_chat_response",
  CF_AGENT_CHAT_CLEAR = "cf_agent_chat_clear",
  CF_AGENT_CHAT_REQUEST_CANCEL = "cf_agent_chat_request_cancel",
  CF_AGENT_STREAM_RESUMING = "cf_agent_stream_resuming",
  CF_AGENT_STREAM_RESUME_ACK = "cf_agent_stream_resume_ack",
  CF_AGENT_MCP_SERVERS = "cf_agent_mcp_servers",
  CF_MCP_AGENT_EVENT = "cf_mcp_agent_event",
  CF_AGENT_STATE = "cf_agent_state",
  RPC = "rpc",
  CF_AGENT_TOOL_RESULT = "cf_agent_tool_result",
  CF_AGENT_MESSAGE_UPDATED = "cf_agent_message_updated"
}

/** Messages sent from Agent to clients */
export type OutgoingMessage<ChatMessage extends UIMessage = UIMessage> =
  | { type: MessageType.CF_AGENT_CHAT_CLEAR }
  | { type: MessageType.CF_AGENT_CHAT_MESSAGES; messages: ChatMessage[] }
  | {
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE;
      id: string;
      body: string;
      done: boolean;
      error?: boolean;
      continuation?: boolean;
    }
  | { type: MessageType.CF_AGENT_STREAM_RESUMING; id: string }
  | { type: MessageType.CF_AGENT_MESSAGE_UPDATED; message: ChatMessage };

/** Messages sent from clients to Agent */
export type IncomingMessage<ChatMessage extends UIMessage = UIMessage> =
  | { type: MessageType.CF_AGENT_CHAT_CLEAR }
  | {
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST;
      id: string;
      init: Pick<
        RequestInit,
        | "method"
        | "keepalive"
        | "headers"
        | "body"
        | "redirect"
        | "integrity"
        | "credentials"
        | "mode"
        | "referrer"
        | "referrerPolicy"
        | "window"
      >;
    }
  | { type: MessageType.CF_AGENT_CHAT_MESSAGES; messages: ChatMessage[] }
  | { type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL; id: string }
  | { type: MessageType.CF_AGENT_STREAM_RESUME_ACK; id: string }
  | {
      type: MessageType.CF_AGENT_TOOL_RESULT;
      toolCallId: string;
      toolName: string;
      output: unknown;
      autoContinue?: boolean;
    };
