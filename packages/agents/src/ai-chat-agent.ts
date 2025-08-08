import type {
  UIMessage as ChatMessage,
  StreamTextOnFinishCallback,
  ToolSet
} from "ai";
import type { Message } from "@ai-sdk/react";
import { Agent, type AgentContext, type Connection, type WSMessage } from "./";
import type { IncomingMessage, OutgoingMessage } from "./ai-types";

const decoder = new TextDecoder();

// Union type for messages that could be legacy or current format
type MessageInput = Message | ChatMessage;

// Extended v4 message interface to handle complex structures
interface V4MessageExtended extends Message {
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  function_call?: {
    name: string;
    arguments: string;
  };
  reasoning?: string;
  attachments?: Array<{
    url: string;
    mimeType: string;
    name?: string;
  }>;
}

/**
 * Helper function to detect v4 messages (with 'content' property)
 * @param message - Message to check
 * @returns true if message is in v4 format
 */
function isV4Message(message: MessageInput): message is V4MessageExtended {
  return (
    "content" in message &&
    typeof message.content === "string" &&
    !("parts" in message)
  );
}

/**
 * Convert v4 message format to UIMessage format with part type mapping
 * @param message - Message in v4 or v5 format
 * @returns Message in UIMessage format
 */
function convertToUIMessage(message: MessageInput): ChatMessage {
  if (isV4Message(message)) {
    const {
      content,
      tool_calls,
      function_call,
      reasoning,
      attachments,
      ...rest
    } = message;
    const parts: Array<{
      type: string;
      text?: string;
      toolCallId?: string;
      toolName?: string;
      args?: Record<string, unknown>;
      state?: string;
      result?: unknown;
      url?: string;
      mediaType?: string;
      name?: string;
    }> = [];

    // Add text content part
    if (content) {
      parts.push({
        type: "text",
        text: content
      });
    }

    // Convert tool_calls to v5 tool invocation parts
    if (tool_calls && Array.isArray(tool_calls)) {
      for (const toolCall of tool_calls) {
        try {
          const args = JSON.parse(toolCall.function.arguments);
          parts.push({
            type: `tool-${toolCall.function.name}`,
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            args,
            state: "call",
            result: undefined
          });
        } catch (_error) {
          // If arguments parsing fails, store as string
          parts.push({
            type: `tool-${toolCall.function.name}`,
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            args: { arguments: toolCall.function.arguments },
            state: "call",
            result: undefined
          });
        }
      }
    }

    // Convert legacy function_call to v5 tool invocation part
    if (function_call) {
      try {
        const args = JSON.parse(function_call.arguments);
        parts.push({
          type: `tool-${function_call.name}`,
          toolCallId: `fc_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
          toolName: function_call.name,
          args,
          state: "call",
          result: undefined
        });
      } catch (_error) {
        // If arguments parsing fails, store as string
        parts.push({
          type: `tool-${function_call.name}`,
          toolCallId: `fc_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
          toolName: function_call.name,
          args: { arguments: function_call.arguments },
          state: "call",
          result: undefined
        });
      }
    }

    // Convert reasoning to reasoning part
    if (reasoning) {
      parts.push({
        type: "reasoning",
        text: reasoning
      });
    }

    // Convert attachments to file parts (mimeType → mediaType)
    if (attachments && Array.isArray(attachments)) {
      for (const attachment of attachments) {
        parts.push({
          type: "file",
          url: attachment.url,
          mediaType: attachment.mimeType, // v4 mimeType → v5 mediaType
          name: attachment.name
        });
      }
    }

    // Ensure we have at least one part (fallback to empty text)
    if (parts.length === 0) {
      parts.push({
        type: "text",
        text: ""
      });
    }

    return {
      ...rest,
      parts
    } as ChatMessage;
  }
  return message as ChatMessage;
}

/**
 * Convert array of messages to UIMessage format
 * @param messages - Array of messages potentially in v4 format
 * @returns Array of messages in UIMessage format
 */
function convertMessagesToUIFormat(messages: MessageInput[]): ChatMessage[] {
  return messages.map(convertToUIMessage);
}

/**
 * Extension of Agent with built-in chat capabilities
 * @template Env Environment type containing bindings
 */
export class AIChatAgent<Env = unknown, State = unknown> extends Agent<
  Env,
  State
> {
  /**
   * Map of message `id`s to `AbortController`s
   * useful to propagate request cancellation signals for any external calls made by the agent
   */
  private _chatMessageAbortControllers: Map<string, AbortController>;
  /** Array of chat messages for the current conversation */
  messages: ChatMessage[];
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.sql`create table if not exists cf_ai_chat_agent_messages (
      id text primary key,
      message text not null,
      created_at datetime default current_timestamp
    )`;
    // Load messages and check/convert format
    const rawMessages = (
      this.sql`select * from cf_ai_chat_agent_messages` || []
    ).map((row) => {
      return JSON.parse(row.message as string);
    });

    // Detect and convert v4 messages to UIMessage format
    this.messages = convertMessagesToUIFormat(rawMessages);

    // If any messages were converted, persist the updated format
    const hasV4Messages = rawMessages.some(isV4Message);
    if (hasV4Messages && this.messages.length > 0) {
      // Re-persist messages in correct format
      this.sql`delete from cf_ai_chat_agent_messages`;
      for (const message of this.messages) {
        this.sql`insert into cf_ai_chat_agent_messages (id, message) values (${
          message.id
        },${JSON.stringify(message)})`;
      }
    }

    this._chatMessageAbortControllers = new Map();
  }

  private _broadcastChatMessage(message: OutgoingMessage, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  override async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message === "string") {
      let data: IncomingMessage;
      try {
        data = JSON.parse(message) as IncomingMessage;
      } catch (_error) {
        // silently ignore invalid messages for now
        // TODO: log errors with log levels
        return;
      }
      if (
        data.type === "cf_agent_use_chat_request" &&
        data.init.method === "POST"
      ) {
        const {
          // method,
          // keepalive,
          // headers,
          body // we're reading this
          //
          // // these might not exist?
          // dispatcher,
          // duplex
        } = data.init;
        const { messages: rawMessages } = JSON.parse(body as string);
        // Convert messages to UIMessage format if needed
        const messages = convertMessagesToUIFormat(rawMessages);

        this._broadcastChatMessage(
          {
            messages,
            type: "cf_agent_chat_messages"
          },
          [connection.id]
        );

        const incomingMessages = this._messagesNotAlreadyInAgent(messages);
        await this.persistMessages(messages, [connection.id]);

        this.observability?.emit(
          {
            displayMessage: "Chat message request",
            id: data.id,
            payload: {
              message: incomingMessages
            },
            timestamp: Date.now(),
            type: "message:request"
          },
          this.ctx
        );

        const chatMessageId = data.id;
        const abortSignal = this._getAbortSignal(chatMessageId);

        return this._tryCatchChat(async () => {
          const uiMessageOnFinish = async (finalMessages: ChatMessage[]) => {
            const outgoingMessages =
              this._messagesNotAlreadyInAgent(finalMessages);
            await this.persistMessages(finalMessages, [connection.id]);
            this._removeAbortController(chatMessageId);

            this.observability?.emit(
              {
                displayMessage: "Chat message response",
                id: data.id,
                payload: {
                  message: outgoingMessages
                },
                timestamp: Date.now(),
                type: "message:response"
              },
              this.ctx
            );
          };

          const onFinish: StreamTextOnFinishCallback<ToolSet> = async () => {
            // This is called when streamText completes
          };

          const response = await this.onChatMessage(
            onFinish,
            abortSignal ? { abortSignal } : undefined,
            uiMessageOnFinish
          );

          if (response) {
            await this._reply(data.id, response);
          } else {
            // Log a warning for observability
            console.warn(
              `[AIChatAgent] onChatMessage returned no response for chatMessageId: ${chatMessageId}`
            );
            // Send a fallback message to the client
            this._broadcastChatMessage(
              {
                body: "No response was generated by the agent.",
                done: true,
                id: data.id,
                type: "cf_agent_use_chat_response"
              },
              [connection.id]
            );
          }
        });
      }
      if (data.type === "cf_agent_chat_clear") {
        this._destroyAbortControllers();
        this.sql`delete from cf_ai_chat_agent_messages`;
        this.messages = [];
        this._broadcastChatMessage(
          {
            type: "cf_agent_chat_clear"
          },
          [connection.id]
        );
      } else if (data.type === "cf_agent_chat_messages") {
        // Convert and replace the messages with the new ones
        const convertedMessages = convertMessagesToUIFormat(data.messages);
        await this.persistMessages(convertedMessages, [connection.id]);
      } else if (data.type === "cf_agent_chat_request_cancel") {
        // propagate an abort signal for the associated request
        this._cancelChatRequest(data.id);
      }
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    return this._tryCatchChat(() => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/get-messages")) {
        const rawMessages = (
          this.sql`select * from cf_ai_chat_agent_messages` || []
        ).map((row) => {
          return JSON.parse(row.message as string);
        });
        // Ensure messages are in UIMessage format
        const messages = convertMessagesToUIFormat(rawMessages);
        return Response.json(messages);
      }
      return super.onRequest(request);
    });
  }

  private async _tryCatchChat<T>(fn: () => T | Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      throw this.onError(e);
    }
  }

  /**
   * Handle incoming chat messages and generate a response
   * @param onFinish Callback to be called when the response is finished
   * @param options.signal A signal to pass to any child requests which can be used to cancel them
   * @param uiMessageOnFinish Callback to be called when UI message stream is finished
   * @returns Response to send to the client or undefined
   */
  async onChatMessage(
    // biome-ignore lint/correctness/noUnusedFunctionParameters: overridden later
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    // biome-ignore lint/correctness/noUnusedFunctionParameters: overridden later
    options?: { abortSignal: AbortSignal | undefined },
    // biome-ignore lint/correctness/noUnusedFunctionParameters: overridden later
    uiMessageOnFinish?: (messages: ChatMessage[]) => Promise<void>
  ): Promise<Response | undefined> {
    throw new Error(
      "recieved a chat message, override onChatMessage and return a Response to send to the client"
    );
  }

  /**
   * Save messages on the server side and trigger AI response
   * @param messages Chat messages to save
   */
  async saveMessages(messages: ChatMessage[]) {
    await this.persistMessages(messages);
    const uiMessageOnFinish = async (finalMessages: ChatMessage[]) => {
      await this.persistMessages(finalMessages, []);
    };
    const onFinish: StreamTextOnFinishCallback<ToolSet> = async () => {
      // This is called when streamText completes
    };
    const response = await this.onChatMessage(
      onFinish,
      undefined,
      uiMessageOnFinish
    );
    if (response) {
      // we're just going to drain the body
      // @ts-ignore TODO: fix this type error
      for await (const chunk of response.body!) {
        decoder.decode(chunk);
      }
      response.body?.cancel();
    }
  }

  async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = []
  ) {
    this.sql`delete from cf_ai_chat_agent_messages`;
    for (const message of messages) {
      this.sql`insert into cf_ai_chat_agent_messages (id, message) values (${
        message.id
      },${JSON.stringify(message)})`;
    }
    this.messages = messages;
    this._broadcastChatMessage(
      {
        messages: messages,
        type: "cf_agent_chat_messages"
      },
      excludeBroadcastIds
    );
  }

  private _messagesNotAlreadyInAgent(messages: ChatMessage[]) {
    const existingIds = new Set(this.messages.map((message) => message.id));
    return messages.filter((message) => !existingIds.has(message.id));
  }

  private async _reply(id: string, response: Response) {
    // now take chunks out from dataStreamResponse and send them to the client
    return this._tryCatchChat(async () => {
      // @ts-expect-error TODO: fix this type error
      for await (const chunk of response.body!) {
        const body = decoder.decode(chunk);

        this._broadcastChatMessage({
          body,
          done: false,
          id,
          type: "cf_agent_use_chat_response"
        });
      }

      this._broadcastChatMessage({
        body: "",
        done: true,
        id,
        type: "cf_agent_use_chat_response"
      });
    });
  }

  /**
   * For the given message id, look up its associated AbortController
   * If the AbortController does not exist, create and store one in memory
   *
   * returns the AbortSignal associated with the AbortController
   */
  private _getAbortSignal(id: string): AbortSignal | undefined {
    // Defensive check, since we're coercing message types at the moment
    if (typeof id !== "string") {
      return undefined;
    }

    if (!this._chatMessageAbortControllers.has(id)) {
      this._chatMessageAbortControllers.set(id, new AbortController());
    }

    return this._chatMessageAbortControllers.get(id)?.signal;
  }

  /**
   * Remove an abort controller from the cache of pending message responses
   */
  private _removeAbortController(id: string) {
    this._chatMessageAbortControllers.delete(id);
  }

  /**
   * Propagate an abort signal for any requests associated with the given message id
   */
  private _cancelChatRequest(id: string) {
    if (this._chatMessageAbortControllers.has(id)) {
      const abortController = this._chatMessageAbortControllers.get(id);
      abortController?.abort();
    }
  }

  /**
   * Abort all pending requests and clear the cache of AbortControllers
   */
  private _destroyAbortControllers() {
    for (const controller of this._chatMessageAbortControllers.values()) {
      controller?.abort();
    }
    this._chatMessageAbortControllers.clear();
  }

  /**
   * When the DO is destroyed, cancel all pending requests
   */
  async destroy() {
    this._destroyAbortControllers();
    await super.destroy();
  }
}
