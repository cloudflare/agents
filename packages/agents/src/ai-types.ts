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

  CF_AGENT_MCP_SERVERS = "cf_agent_mcp_servers",
  CF_MCP_AGENT_EVENT = "cf_mcp_agent_event",
  CF_AGENT_STATE = "cf_agent_state",
  RPC = "rpc"
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
    }
  | {
      /** Indicates the server is resuming an active stream */
      type: MessageType.CF_AGENT_STREAM_RESUMING;
      /** The request ID of the stream being resumed */
      id: string;
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
    };
