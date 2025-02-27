import type { Message as ChatMessage } from "ai";

/**
 * Types of messages sent from the Agent to clients
 */
export type OutgoingMessage =
  | {
      /** Indicates this message contains updated chat messages */
      type: "cf_agent_chat_messages";
      /** Array of chat messages */
      messages: ChatMessage[];
    }
  | {
      /** Indicates this message is a response to a chat request */
      type: "cf_agent_use_chat_response";
      /** Unique ID of the request this response corresponds to */
      id: string;
      /** Content body of the response */
      body: string;
      /** Whether this is the final chunk of the response */
      done: boolean;
    }
  | {
      /** Indicates this message contains updated chat messages */
      type: "cf_agent_chat_messages";
      /** Array of chat messages */
      messages: ChatMessage[];
    }
  | {
      /** Indicates this message is a command to clear chat history */
      type: "cf_agent_chat_clear";
    };

/**
 * Types of messages sent from clients to the Agent
 */
export type IncomingMessage =
  | {
      /** Indicates this message is initializing a chat connection */
      type: "cf_agent_chat_init";
      /** Initial messages to load, if any */
      messages: ChatMessage[];
    }
  | {
      /** Indicates this message is a request to the chat API */
      type: "cf_agent_use_chat_request";
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
      /** Indicates this message is a command to clear chat history */
      type: "cf_agent_chat_clear";
    }
  | {
      /** Indicates this message contains updated chat messages */
      type: "cf_agent_chat_messages";
      /** Array of chat messages */
      messages: ChatMessage[];
    };
