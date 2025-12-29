import type { UIMessage } from "ai";

/**
 * Enum for message types to improve type safety and maintainability
 */
export enum MessageType {
  CF_AGENT_CHAT_MESSAGES = "cf_agent_chat_messages",
  CF_AGENT_USE_CHAT_REQUEST = "cf_agent_use_chat_request",
  CF_AGENT_USE_CHAT_RESPONSE = "cf_agent_use_chat_response",
  CF_AGENT_CHAT_CLEAR = "cf_agent_chat_clear",
  CF_AGENT_CHAT_REQUEST_CANCEL = "cf_agent_chat_request_cancel",

  /** Sent by server when client connects and there's an active stream to resume */
  CF_AGENT_STREAM_RESUMING = "cf_agent_stream_resuming",
  /** Sent by client to acknowledge stream resuming notification and request chunks */
  CF_AGENT_STREAM_RESUME_ACK = "cf_agent_stream_resume_ack",

  /** Client sends tool result to server (for client-side tools) */
  CF_AGENT_TOOL_RESULT = "cf_agent_tool_result",
  /** Server notifies client that a message was updated (e.g., tool result applied) */
  CF_AGENT_MESSAGE_UPDATED = "cf_agent_message_updated"
}

/**
 * Types of messages sent from the Agent to clients
 */
export type OutgoingMessage<ChatMessage extends UIMessage = UIMessage> =
  | {
      /** Indicates this message is a command to clear chat history */
      type: MessageType.CF_AGENT_CHAT_CLEAR;
    }
  | {
      /** Indicates this message contains updated chat messages */
      type: MessageType.CF_AGENT_CHAT_MESSAGES;
      /** Array of chat messages */
      messages: ChatMessage[];
    }
  | {
      /** Indicates this message is a response to a chat request */
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE;
      /** Unique ID of the request this response corresponds to */
      id: string;
      /** Content body of the response */
      body: string;
      /** Whether this is the final chunk of the response */
      done: boolean;
      /** Whether this response contains an error */
      error?: boolean;
      /** Whether this is a continuation (append to last assistant message) */
      continuation?: boolean;
    }
  | {
      /** Indicates the server is resuming an active stream */
      type: MessageType.CF_AGENT_STREAM_RESUMING;
      /** The request ID of the stream being resumed */
      id: string;
    }
  | {
      /** Server notifies client that a message was updated (e.g., tool result applied) */
      type: MessageType.CF_AGENT_MESSAGE_UPDATED;
      /** The updated message */
      message: ChatMessage;
    };

/**
 * Types of messages sent from clients to the Agent
 */
export type IncomingMessage<ChatMessage extends UIMessage = UIMessage> =
  | {
      /** Indicates this message is a command to clear chat history */
      type: MessageType.CF_AGENT_CHAT_CLEAR;
    }
  | {
      /** Indicates this message is a request to the chat API */
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST;
      /** Unique ID for this request */
      id: string;
      /** Request initialization options */
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
  | {
      /** Indicates this message contains updated chat messages */
      type: MessageType.CF_AGENT_CHAT_MESSAGES;
      /** Array of chat messages */
      messages: ChatMessage[];
    }
  | {
      /** Indicates the user wants to stop generation of this message */
      type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL;
      id: string;
    }
  | {
      /** Client acknowledges stream resuming notification and is ready to receive chunks */
      type: MessageType.CF_AGENT_STREAM_RESUME_ACK;
      /** The request ID of the stream being resumed */
      id: string;
    }
  | {
      /** Client sends tool result to server (for client-side tools) */
      type: MessageType.CF_AGENT_TOOL_RESULT;
      /** The tool call ID this result is for */
      toolCallId: string;
      /** The name of the tool */
      toolName: string;
      /** The output from the tool execution */
      output: unknown;
      /** Whether server should auto-continue the conversation after applying result */
      autoContinue?: boolean;
    };
