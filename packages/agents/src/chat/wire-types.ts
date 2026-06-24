import type { JSONSchema7, UIMessage } from "ai";

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
  /** Sent by client after message handler is ready, requesting stream resume check */
  CF_AGENT_STREAM_RESUME_REQUEST = "cf_agent_stream_resume_request",
  /** Sent by server when client requests resume but no active stream exists */
  CF_AGENT_STREAM_RESUME_NONE = "cf_agent_stream_resume_none",
  /**
   * Sent by server when a turn is accepted but its resumable stream has not
   * started yet (queued / debouncing / waiting on MCP / async setup). Tells a
   * reconnecting client to keep waiting rather than resolve its resume probe to
   * "no stream". Resolved by a later `CF_AGENT_STREAM_RESUMING` (stream started)
   * or `CF_AGENT_STREAM_RESUME_NONE` (settled without streaming). See #1784.
   */
  CF_AGENT_STREAM_PENDING = "cf_agent_stream_pending",

  /** Client sends tool result to server (for client-side tools) */
  CF_AGENT_TOOL_RESULT = "cf_agent_tool_result",
  /** Server notifies client that a message was updated (e.g., tool result applied) */
  CF_AGENT_MESSAGE_UPDATED = "cf_agent_message_updated",
  /** Client sends tool approval response to server (for tools with needsApproval) */
  CF_AGENT_TOOL_APPROVAL = "cf_agent_tool_approval",

  /**
   * Server→client progress hint: a durable chat turn is being recovered
   * (interrupted by a deploy/eviction or a stream-stall watchdog abort and now
   * resuming). Sent when a recovery continuation is scheduled and cleared on
   * every terminal outcome. (`@cloudflare/think` also replays it on connect;
   * `@cloudflare/ai-chat` broadcasts the live signal only — see #1645.)
   * Backward-compatible — clients that don't understand it ignore it. See #1620.
   */
  CF_AGENT_CHAT_RECOVERING = "cf_agent_chat_recovering"
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
      messages: readonly ChatMessage[];
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
      /** Whether this chunk is being replayed from storage (stream resumption) */
      replay?: boolean;
      /** Signals that replay of stored chunks is complete (stream is still active) */
      replayComplete?: boolean;
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
    }
  | {
      /** Server responds to resume request when no active stream exists */
      type: MessageType.CF_AGENT_STREAM_RESUME_NONE;
    }
  | {
      /**
       * Server signals an accepted turn whose resumable stream has not started
       * yet — the client should keep waiting for `STREAM_RESUMING` (or a later
       * `STREAM_RESUME_NONE`) rather than give up. See #1784.
       */
      type: MessageType.CF_AGENT_STREAM_PENDING;
      /** The accepted request id, when known. */
      id?: string;
    }
  | {
      /**
       * Progress hint: a durable chat turn is being recovered (`recovering:
       * true`) or recovery has resolved (`recovering: false`). Purely advisory;
       * a client renders a "recovering…" indicator while true.
       */
      type: MessageType.CF_AGENT_CHAT_RECOVERING;
      /** Whether recovery is in progress (true) or has resolved (false). */
      recovering: boolean;
      /** The recovery-root request id of the turn being recovered, if known. */
      id?: string;
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
      /** Client requests stream resume check after message handler is registered */
      type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST;
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
      /** Override the tool part state (e.g. "output-error" for custom denial) */
      state?: "output-available" | "output-error";
      /** Error message when state is "output-error" */
      errorText?: string;
      /** Whether server should auto-continue the conversation after applying result */
      autoContinue?: boolean;
      /** Client tool schemas for continuation (client is source of truth) */
      clientTools?: Array<{
        name: string;
        description?: string;
        parameters?: JSONSchema7;
      }>;
    }
  | {
      /** Client sends tool approval response to server (for tools with needsApproval) */
      type: MessageType.CF_AGENT_TOOL_APPROVAL;
      /** The tool call ID this approval is for */
      toolCallId: string;
      /** Whether the tool execution was approved */
      approved: boolean;
      /** Whether server should auto-continue the conversation after applying approval */
      autoContinue?: boolean;
    };
