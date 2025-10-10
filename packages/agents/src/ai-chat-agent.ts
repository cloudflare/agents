import type {
  UIMessage as ChatMessage,
  DynamicToolUIPart,
  ProviderMetadata,
  ReasoningUIPart,
  StreamTextOnFinishCallback,
  TextUIPart,
  ToolSet,
  ToolUIPart,
  UIMessageChunk
} from "ai";
import { Agent, type AgentContext, type Connection, type WSMessage } from "./";
import {
  MessageType,
  type IncomingMessage,
  type OutgoingMessage
} from "./ai-types";
import { autoTransformMessages } from "./ai-chat-v5-migration";

const decoder = new TextDecoder();

// Lazy-load AI SDK utilities
type AISDK = {
  getToolName: typeof import("ai").getToolName;
  isToolUIPart: typeof import("ai").isToolUIPart;
  parsePartialJson: typeof import("ai").parsePartialJson;
};
let aiSDK: AISDK | undefined;
function getAISDK() {
  if (!aiSDK) {
    // Use destructuring to help with tree-shaking
    const { getToolName, isToolUIPart, parsePartialJson } = require("ai");
    aiSDK = {
      getToolName,
      isToolUIPart,
      parsePartialJson
    };
  }
  return aiSDK!;
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

    // Load messages and automatically transform them to v5 format
    const rawMessages = this._loadMessagesFromDb();

    // Automatic migration following https://jhak.im/blog/ai-sdk-migration-handling-previously-saved-messages
    this.messages = autoTransformMessages(rawMessages);

    this._chatMessageAbortControllers = new Map();
  }

  private _broadcastChatMessage(message: OutgoingMessage, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  private _loadMessagesFromDb(): ChatMessage[] {
    const rows =
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      [];
    return rows
      .map((row) => {
        try {
          return JSON.parse(row.message as string);
        } catch (error) {
          console.error(`Failed to parse message ${row.id}:`, error);
          return null;
        }
      })
      .filter((msg): msg is ChatMessage => msg !== null);
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
        data.type === MessageType.CF_AGENT_USE_CHAT_REQUEST &&
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
        const { messages } = JSON.parse(body as string);

        // Automatically transform any incoming messages
        const transformedMessages = autoTransformMessages(messages);

        this._broadcastChatMessage(
          {
            messages: transformedMessages,
            type: MessageType.CF_AGENT_CHAT_MESSAGES
          },
          [connection.id]
        );

        await this.persistMessages(transformedMessages, [connection.id]);

        this.observability?.emit(
          {
            displayMessage: "Chat message request",
            id: data.id,
            payload: {},
            timestamp: Date.now(),
            type: "message:request"
          },
          this.ctx
        );

        const chatMessageId = data.id;
        const abortSignal = this._getAbortSignal(chatMessageId);

        return this._tryCatchChat(async () => {
          const response = await this.onChatMessage(
            async (_finishResult) => {
              this._removeAbortController(chatMessageId);

              this.observability?.emit(
                {
                  displayMessage: "Chat message response",
                  id: data.id,
                  payload: {},
                  timestamp: Date.now(),
                  type: "message:response"
                },
                this.ctx
              );

              // Note: Message persistence now happens in the _reply method
              // after the complete response text has been accumulated
            },
            abortSignal ? { abortSignal } : undefined
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
                type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
              },
              [connection.id]
            );
          }
        });
      }
      if (data.type === MessageType.CF_AGENT_CHAT_CLEAR) {
        this._destroyAbortControllers();
        this.sql`delete from cf_ai_chat_agent_messages`;
        this.messages = [];
        this._broadcastChatMessage(
          {
            type: MessageType.CF_AGENT_CHAT_CLEAR
          },
          [connection.id]
        );
      } else if (data.type === MessageType.CF_AGENT_CHAT_MESSAGES) {
        // replace the messages with the new ones, automatically transformed
        const transformedMessages = autoTransformMessages(data.messages);
        await this.persistMessages(transformedMessages, [connection.id]);
      } else if (data.type === MessageType.CF_AGENT_CHAT_REQUEST_CANCEL) {
        // propagate an abort signal for the associated request
        this._cancelChatRequest(data.id);
      }
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    return this._tryCatchChat(() => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/get-messages")) {
        const messages = this._loadMessagesFromDb();
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
   * @returns Response to send to the client or undefined
   */
  async onChatMessage(
    // biome-ignore lint/correctness/noUnusedFunctionParameters: overridden later
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    // biome-ignore lint/correctness/noUnusedFunctionParameters: overridden later
    options?: { abortSignal: AbortSignal | undefined }
  ): Promise<Response | undefined> {
    throw new Error(
      "recieved a chat message, override onChatMessage and return a Response to send to the client"
    );
  }

  /**
   * Save messages on the server side
   * @param messages Chat messages to save
   */
  async saveMessages(messages: ChatMessage[]) {
    await this.persistMessages(messages);
    await this._tryCatchChat(async () => {
      const response = await this.onChatMessage(() => {});
      if (response) this._reply(crypto.randomUUID(), response);
    });
  }

  async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = []
  ) {
    for (const message of messages) {
      this.sql`
        insert into cf_ai_chat_agent_messages (id, message)
        values (${message.id}, ${JSON.stringify(message)})
        on conflict(id) do update set message = excluded.message
      `;
    }

    // refresh in-memory messages
    const persisted = this._loadMessagesFromDb();
    this.messages = autoTransformMessages(persisted);
    this._broadcastChatMessage(
      {
        messages: messages,
        type: MessageType.CF_AGENT_CHAT_MESSAGES
      },
      excludeBroadcastIds
    );
  }

  private async _reply(id: string, response: Response) {
    return this._tryCatchChat(async () => {
      if (!response.body) {
        // Send empty response if no body
        this._broadcastChatMessage({
          body: "",
          done: true,
          id,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
        });
        return;
      }

      const reader = response.body.getReader();

      // Parsing state adapted from:
      // https://github.com/vercel/ai/blob/main/packages/ai/src/ui-message-stream/ui-message-chunks.ts#L295
      const message: ChatMessage = {
        id: `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`, // default
        role: "assistant",
        parts: []
      };
      let activeTextParts: Record<string, TextUIPart> = {};
      let activeReasoningParts: Record<string, ReasoningUIPart> = {};
      const partialToolCalls: Record<
        string,
        { text: string; index: number; toolName: string; dynamic?: boolean }
      > = {};

      function updateDynamicToolPart(
        options: {
          toolName: string;
          toolCallId: string;
          providerExecuted?: boolean;
        } & (
          | {
              state: "input-streaming";
              input: unknown;
            }
          | {
              state: "input-available";
              input: unknown;
              providerMetadata?: ProviderMetadata;
            }
          | {
              state: "output-available";
              input: unknown;
              output: unknown;
              preliminary: boolean | undefined;
            }
          | {
              state: "output-error";
              input: unknown;
              errorText: string;
              providerMetadata?: ProviderMetadata;
            }
        )
      ) {
        const part = message.parts.find(
          (part) =>
            part.type === "dynamic-tool" &&
            part.toolCallId === options.toolCallId
        ) as DynamicToolUIPart | undefined;

        const anyOptions = options as Record<string, unknown>;
        const anyPart = part as Record<string, unknown>;

        if (part != null) {
          part.state = options.state;
          anyPart.toolName = options.toolName;
          anyPart.input = anyOptions.input;
          anyPart.output = anyOptions.output;
          anyPart.errorText = anyOptions.errorText;
          anyPart.rawInput = anyOptions.rawInput ?? anyPart.rawInput;
          anyPart.preliminary = anyOptions.preliminary;

          if (
            anyOptions.providerMetadata != null &&
            part.state === "input-available"
          ) {
            part.callProviderMetadata =
              anyOptions.providerMetadata as ProviderMetadata;
          }
        } else {
          message.parts.push({
            type: "dynamic-tool",
            toolName: options.toolName,
            toolCallId: options.toolCallId,
            state: options.state,
            input: anyOptions.input,
            output: anyOptions.output,
            errorText: anyOptions.errorText,
            preliminary: anyOptions.preliminary,
            ...(anyOptions.providerMetadata != null
              ? { callProviderMetadata: anyOptions.providerMetadata }
              : {})
          } as DynamicToolUIPart);
        }
      }

      function updateToolPart(
        options: {
          toolName: string;
          toolCallId: string;
          providerExecuted?: boolean;
        } & (
          | {
              state: "input-streaming";
              input: unknown;
              providerExecuted?: boolean;
            }
          | {
              state: "input-available";
              input: unknown;
              providerExecuted?: boolean;
              providerMetadata?: ProviderMetadata;
            }
          | {
              state: "output-available";
              input: unknown;
              output: unknown;
              providerExecuted?: boolean;
              preliminary?: boolean;
            }
          | {
              state: "output-error";
              input: unknown;
              rawInput?: unknown;
              errorText: string;
              providerExecuted?: boolean;
              providerMetadata?: ProviderMetadata;
            }
        )
      ) {
        const { isToolUIPart } = getAISDK();
        const part = message.parts.find(
          (part) =>
            isToolUIPart(part) &&
            (part as ToolUIPart).toolCallId === options.toolCallId
        ) as ToolUIPart | undefined;

        const anyOptions = options as Record<string, unknown>;
        const anyPart = part as Record<string, unknown>;

        if (part != null) {
          part.state = options.state;
          anyPart.input = anyOptions.input;
          anyPart.output = anyOptions.output;
          anyPart.errorText = anyOptions.errorText;
          anyPart.rawInput = anyOptions.rawInput;
          anyPart.preliminary = anyOptions.preliminary;

          // once providerExecuted is set, it stays for streaming
          anyPart.providerExecuted =
            anyOptions.providerExecuted ?? part.providerExecuted;

          if (
            anyOptions.providerMetadata != null &&
            part.state === "input-available"
          ) {
            part.callProviderMetadata =
              anyOptions.providerMetadata as ProviderMetadata;
          }
        } else {
          message.parts.push({
            type: `tool-${options.toolName}`,
            toolCallId: options.toolCallId,
            state: options.state,
            input: anyOptions.input,
            output: anyOptions.output,
            rawInput: anyOptions.rawInput,
            errorText: anyOptions.errorText,
            providerExecuted: anyOptions.providerExecuted,
            preliminary: anyOptions.preliminary,
            ...(anyOptions.providerMetadata != null
              ? { callProviderMetadata: anyOptions.providerMetadata }
              : {})
          } as ToolUIPart);
        }
      }

      async function updateMessageMetadata(metadata: unknown) {
        if (metadata != null) {
          const mergedMetadata =
            message.metadata != null
              ? { ...message.metadata, ...metadata } // TODO: do proper merging
              : metadata;

          message.metadata = mergedMetadata;
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Send final completion signal
            this._broadcastChatMessage({
              body: "",
              done: true,
              id,
              type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
            });
            break;
          }

          const chunk = decoder.decode(value);

          // Determine response format based on content-type
          const contentType = response.headers.get("content-type") || "";
          const isSSE = contentType.includes("text/event-stream");

          // After streaming is complete, persist the complete assistant's response
          if (isSSE) {
            // Parse AI SDK v5 SSE format and extract text deltas
            const lines = chunk.split("\n");
            for (const line of lines) {
              if (line.startsWith("data: ") && line !== "data: [DONE]") {
                try {
                  const data: UIMessageChunk = JSON.parse(line.slice(6)); // Remove 'data: ' prefix
                  switch (data.type) {
                    case "text-start": {
                      const textPart: TextUIPart = {
                        type: "text",
                        text: "",
                        providerMetadata: data.providerMetadata,
                        state: "streaming"
                      };
                      activeTextParts[data.id] = textPart;
                      message.parts.push(textPart);
                      break;
                    }

                    case "text-delta": {
                      const textPart = activeTextParts[data.id];
                      textPart.text += data.delta;
                      textPart.providerMetadata =
                        data.providerMetadata ?? textPart.providerMetadata;
                      break;
                    }

                    case "text-end": {
                      const textPart = activeTextParts[data.id];
                      textPart.state = "done";
                      textPart.providerMetadata =
                        data.providerMetadata ?? textPart.providerMetadata;
                      delete activeTextParts[data.id];
                      break;
                    }

                    case "reasoning-start": {
                      const reasoningPart: ReasoningUIPart = {
                        type: "reasoning",
                        text: "",
                        providerMetadata: data.providerMetadata,
                        state: "streaming"
                      };
                      activeReasoningParts[data.id] = reasoningPart;
                      message.parts.push(reasoningPart);
                      break;
                    }

                    case "reasoning-delta": {
                      const reasoningPart = activeReasoningParts[data.id];
                      reasoningPart.text += data.delta;
                      reasoningPart.providerMetadata =
                        data.providerMetadata ?? reasoningPart.providerMetadata;
                      break;
                    }

                    case "reasoning-end": {
                      const reasoningPart = activeReasoningParts[data.id];
                      reasoningPart.providerMetadata =
                        data.providerMetadata ?? reasoningPart.providerMetadata;
                      reasoningPart.state = "done";
                      delete activeReasoningParts[data.id];

                      break;
                    }

                    case "file": {
                      message.parts.push({
                        type: "file",
                        mediaType: data.mediaType,
                        url: data.url
                      });

                      break;
                    }

                    case "source-url": {
                      message.parts.push({
                        type: "source-url",
                        sourceId: data.sourceId,
                        url: data.url,
                        title: data.title,
                        providerMetadata: data.providerMetadata
                      });

                      break;
                    }

                    case "source-document": {
                      message.parts.push({
                        type: "source-document",
                        sourceId: data.sourceId,
                        mediaType: data.mediaType,
                        title: data.title,
                        filename: data.filename,
                        providerMetadata: data.providerMetadata
                      });

                      break;
                    }

                    case "tool-input-start": {
                      const { isToolUIPart } = getAISDK();
                      const toolInvocations =
                        message.parts.filter(isToolUIPart);

                      // add the partial tool call to the map
                      partialToolCalls[data.toolCallId] = {
                        text: "",
                        toolName: data.toolName,
                        index: toolInvocations.length,
                        dynamic: data.dynamic
                      };

                      if (data.dynamic) {
                        updateDynamicToolPart({
                          toolCallId: data.toolCallId,
                          toolName: data.toolName,
                          state: "input-streaming",
                          input: undefined
                        });
                      } else {
                        updateToolPart({
                          toolCallId: data.toolCallId,
                          toolName: data.toolName,
                          state: "input-streaming",
                          input: undefined
                        });
                      }

                      break;
                    }

                    case "tool-input-delta": {
                      const partialToolCall = partialToolCalls[data.toolCallId];

                      partialToolCall.text += data.inputTextDelta;

                      const { parsePartialJson } = getAISDK();
                      const partialArgsResult = await parsePartialJson(
                        partialToolCall.text
                      );
                      const partialArgs = (
                        partialArgsResult as { value: Record<string, unknown> }
                      ).value;

                      if (partialToolCall.dynamic) {
                        updateDynamicToolPart({
                          toolCallId: data.toolCallId,
                          toolName: partialToolCall.toolName,
                          state: "input-streaming",
                          input: partialArgs
                        });
                      } else {
                        updateToolPart({
                          toolCallId: data.toolCallId,
                          toolName: partialToolCall.toolName,
                          state: "input-streaming",
                          input: partialArgs
                        });
                      }

                      break;
                    }

                    case "tool-input-available": {
                      if (data.dynamic) {
                        updateDynamicToolPart({
                          toolCallId: data.toolCallId,
                          toolName: data.toolName,
                          state: "input-available",
                          input: data.input,
                          providerMetadata: data.providerMetadata
                        });
                      } else {
                        updateToolPart({
                          toolCallId: data.toolCallId,
                          toolName: data.toolName,
                          state: "input-available",
                          input: data.input,
                          providerExecuted: data.providerExecuted,
                          providerMetadata: data.providerMetadata
                        });
                      }

                      // TODO: Do we want to expose onToolCall?

                      // invoke the onToolCall callback if it exists. This is blocking.
                      // In the future we should make this non-blocking, which
                      // requires additional state management for error handling etc.
                      // Skip calling onToolCall for provider-executed tools since they are already executed
                      // if (onToolCall && !data.providerExecuted) {
                      //   await onToolCall({
                      //     toolCall: data
                      //   });
                      // }
                      break;
                    }

                    case "tool-input-error": {
                      if (data.dynamic) {
                        updateDynamicToolPart({
                          toolCallId: data.toolCallId,
                          toolName: data.toolName,
                          state: "output-error",
                          input: data.input,
                          errorText: data.errorText,
                          providerMetadata: data.providerMetadata
                        });
                      } else {
                        updateToolPart({
                          toolCallId: data.toolCallId,
                          toolName: data.toolName,
                          state: "output-error",
                          input: undefined,
                          rawInput: data.input,
                          errorText: data.errorText,
                          providerExecuted: data.providerExecuted,
                          providerMetadata: data.providerMetadata
                        });
                      }

                      break;
                    }

                    case "tool-output-available": {
                      if (data.dynamic) {
                        const toolInvocations = message.parts.filter(
                          (part) => part.type === "dynamic-tool"
                        ) as DynamicToolUIPart[];

                        const toolInvocation = toolInvocations.find(
                          (invocation) =>
                            invocation.toolCallId === data.toolCallId
                        );

                        if (!toolInvocation)
                          throw new Error("Tool invocation not found");

                        updateDynamicToolPart({
                          toolCallId: data.toolCallId,
                          toolName: toolInvocation.toolName,
                          state: "output-available",
                          input: toolInvocation.input,
                          output: data.output,
                          preliminary: data.preliminary
                        });
                      } else {
                        const { isToolUIPart, getToolName } = getAISDK();
                        const toolInvocations = message.parts.filter(
                          isToolUIPart
                        ) as ToolUIPart[];

                        const toolInvocation = toolInvocations.find(
                          (invocation) =>
                            invocation.toolCallId === data.toolCallId
                        );

                        if (!toolInvocation)
                          throw new Error("Tool invocation not found");

                        updateToolPart({
                          toolCallId: data.toolCallId,
                          toolName: getToolName(toolInvocation),
                          state: "output-available",
                          input: toolInvocation.input,
                          output: data.output,
                          providerExecuted: data.providerExecuted,
                          preliminary: data.preliminary
                        });
                      }

                      break;
                    }

                    case "tool-output-error": {
                      if (data.dynamic) {
                        const toolInvocations = message.parts.filter(
                          (part) => part.type === "dynamic-tool"
                        ) as DynamicToolUIPart[];

                        const toolInvocation = toolInvocations.find(
                          (invocation) =>
                            invocation.toolCallId === data.toolCallId
                        );

                        if (!toolInvocation)
                          throw new Error("Tool invocation not found");

                        updateDynamicToolPart({
                          toolCallId: data.toolCallId,
                          toolName: toolInvocation.toolName,
                          state: "output-error",
                          input: toolInvocation.input,
                          errorText: data.errorText
                        });
                      } else {
                        const { isToolUIPart, getToolName } = getAISDK();
                        const toolInvocations = message.parts.filter(
                          isToolUIPart
                        ) as ToolUIPart[];

                        const toolInvocation = toolInvocations.find(
                          (invocation) =>
                            invocation.toolCallId === data.toolCallId
                        );

                        if (!toolInvocation)
                          throw new Error("Tool invocation not found");
                        updateToolPart({
                          toolCallId: data.toolCallId,
                          toolName: getToolName(toolInvocation),
                          state: "output-error",
                          input: toolInvocation.input,
                          rawInput:
                            "rawInput" in toolInvocation
                              ? toolInvocation.rawInput
                              : undefined,
                          errorText: data.errorText
                        });
                      }

                      break;
                    }

                    case "start-step": {
                      // add a step boundary part to the message
                      message.parts.push({ type: "step-start" });
                      break;
                    }

                    case "finish-step": {
                      // reset the current text and reasoning parts
                      activeTextParts = {};
                      activeReasoningParts = {};
                      break;
                    }

                    case "start": {
                      if (data.messageId != null) {
                        message.id = data.messageId;
                      }

                      await updateMessageMetadata(data.messageMetadata);

                      break;
                    }

                    case "finish": {
                      await updateMessageMetadata(data.messageMetadata);
                      break;
                    }

                    case "message-metadata": {
                      await updateMessageMetadata(data.messageMetadata);
                      break;
                    }

                    case "error": {
                      this._broadcastChatMessage({
                        error: true,
                        body: data.errorText ?? JSON.stringify(data),
                        done: false,
                        id,
                        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
                      });

                      break;
                    }
                    // Do we want to handle data parts?
                  }

                  // Always forward the raw part to the client
                  this._broadcastChatMessage({
                    body: JSON.stringify(data),
                    done: false,
                    id,
                    type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
                  });
                } catch (_e) {
                  // Skip malformed JSON lines silently
                }
              }
            }
          } else {
            // Handle plain text responses (e.g., from generateText)
            // Treat the entire chunk as a text delta to preserve exact formatting
            if (chunk.length > 0) {
              message.parts.push({ type: "text", text: chunk });
              // Synthesize a text-delta event so clients can stream-render
              this._broadcastChatMessage({
                body: JSON.stringify({ type: "text-delta", delta: chunk }),
                done: false,
                id,
                type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
              });
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (message.parts.length > 0) {
        await this.persistMessages([...this.messages, message]);
      }
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
