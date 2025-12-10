import { useChat, type UseChatOptions } from "@ai-sdk/react";
import { getToolName, isToolUIPart } from "ai";
import type {
  ChatInit,
  ChatTransport,
  UIMessage as Message,
  UIMessage
} from "ai";
import { DefaultChatTransport } from "ai";
import { nanoid } from "nanoid";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OutgoingMessage } from "./ai-types";
import { MessageType } from "./ai-types";
import type { useAgent } from "./react";

export type AITool<Input = unknown, Output = unknown> = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: Input) => Output | Promise<Output>;
};

/**
 * JSON Schema type for tool parameters.
 * Supports common JSON Schema properties with an index signature
 * for extension properties like $ref, format, minimum, maximum, etc.
 */
export type JSONSchemaType = {
  type?: "object" | "string" | "number" | "boolean" | "array" | "null";
  properties?: Record<string, JSONSchemaType>;
  items?: JSONSchemaType;
  required?: string[];
  description?: string;
  enum?: (string | number | boolean | null)[];
  default?: unknown;
  // Additional JSON Schema properties
  $ref?: string;
  $id?: string;
  $schema?: string;
  title?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JSONSchemaType;
  // Allow other JSON Schema extension properties
  [key: string]: unknown;
};

/**
 * Definition for a client-side tool that can be sent to the server.
 */
export type ClientTool = {
  /** Unique name for the tool */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** JSON Schema defining the tool's input parameters */
  parameters?: JSONSchemaType;
};

type GetInitialMessagesOptions = {
  agent: string;
  name: string;
  url: string;
};

// v5 useChat parameters
type UseChatParams<M extends UIMessage = UIMessage> = ChatInit<M> &
  UseChatOptions<M>;

/**
 * Options for preparing the send messages request.
 * Used by prepareSendMessagesRequest callback.
 */
export type PrepareSendMessagesRequestOptions<
  ChatMessage extends UIMessage = UIMessage
> = {
  /** The chat ID */
  id: string;
  /** Messages to send */
  messages: ChatMessage[];
  /** What triggered this request */
  trigger: "submit-message" | "regenerate-message";
  /** ID of the message being sent (if applicable) */
  messageId?: string;
  /** Request metadata */
  requestMetadata?: unknown;
  /** Current body (if any) */
  body?: Record<string, unknown>;
  /** Current credentials (if any) */
  credentials?: RequestCredentials;
  /** Current headers (if any) */
  headers?: HeadersInit;
  /** API endpoint */
  api?: string;
};

/**
 * Return type for prepareSendMessagesRequest callback.
 * Allows customizing headers, body, and credentials for each request.
 * All fields are optional; only specify what you need to customize.
 */
export type PrepareSendMessagesRequestResult = {
  /** Custom headers to send with the request */
  headers?: HeadersInit;
  /** Custom body data to merge with the request */
  body?: Record<string, unknown>;
  /** Custom credentials option */
  credentials?: RequestCredentials;
  /** Custom API endpoint */
  api?: string;
};

/**
 * Internal type for AI SDK transport
 * @internal
 */
type InternalPrepareResult = {
  body: Record<string, unknown>;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
  api?: string;
};

/**
 * Options for the useAgentChat hook
 */
type UseAgentChatOptions<
  State,
  ChatMessage extends UIMessage = UIMessage
> = Omit<UseChatParams<ChatMessage>, "fetch"> & {
  /** Agent connection from useAgent */
  agent: ReturnType<typeof useAgent<State>>;
  getInitialMessages?:
    | undefined
    | null
    | ((options: GetInitialMessagesOptions) => Promise<ChatMessage[]>);
  /** Request credentials */
  credentials?: RequestCredentials;
  /** Request headers */
  headers?: HeadersInit;
  /**
   * @description Whether to automatically resolve tool calls that do not require human interaction.
   * @experimental
   */
  experimental_automaticToolResolution?: boolean;
  /**
   * @description Tools object for automatic detection of confirmation requirements.
   * Tools without execute function will require confirmation.
   */
  tools?: Record<string, AITool<unknown, unknown>>;
  /**
   * @description Manual override for tools requiring confirmation.
   * If not provided, will auto-detect from tools object.
   */
  toolsRequiringConfirmation?: string[];
  /**
   * When true (default), automatically sends the next message only after
   * all pending confirmation-required tool calls have been resolved.
   * @default true
   */
  autoSendAfterAllConfirmationsResolved?: boolean;
  /**
   * Set to false to disable automatic stream resumption.
   * @default true
   */
  resume?: boolean;
  /**
   * Client-side tool definitions to send to the server with each request.
   * This is the simple way to register tools that can be executed on the client.
   * The server will receive these tool schemas and can include them when calling the AI model.
   */
  clientTools?: ClientTool[];
  /**
   * Callback to customize the request before sending messages.
   */
  prepareSendMessagesRequest?: (
    options: PrepareSendMessagesRequestOptions<ChatMessage>
  ) =>
    | PrepareSendMessagesRequestResult
    | Promise<PrepareSendMessagesRequestResult>;
};

const requestCache = new Map<string, Promise<Message[]>>();

/**
 * React hook for building AI chat interfaces using an Agent
 * @param options Chat options including the agent connection
 * @returns Chat interface controls and state with added clearHistory method
 */
/**
 * Automatically detects which tools require confirmation based on their configuration.
 * Tools require confirmation if they have no execute function AND are not server-executed.
 * @param tools - Record of tool name to tool definition
 * @returns Array of tool names that require confirmation
 */
export function detectToolsRequiringConfirmation(
  tools?: Record<string, AITool<unknown, unknown>>
): string[] {
  if (!tools) return [];

  return Object.entries(tools)
    .filter(([_name, tool]) => !tool.execute)
    .map(([name]) => name);
}

export function useAgentChat<
  State = unknown,
  ChatMessage extends UIMessage = UIMessage
>(
  options: UseAgentChatOptions<State, ChatMessage>
): ReturnType<typeof useChat<ChatMessage>> & {
  clearHistory: () => void;
} {
  const {
    agent,
    getInitialMessages,
    messages: optionsInitialMessages,
    experimental_automaticToolResolution,
    tools,
    toolsRequiringConfirmation: manualToolsRequiringConfirmation,
    autoSendAfterAllConfirmationsResolved = true,
    resume = true, // Enable stream resumption by default
    clientTools,
    prepareSendMessagesRequest,
    ...rest
  } = options;

  // Auto-detect tools requiring confirmation, or use manual override
  const toolsRequiringConfirmation =
    manualToolsRequiringConfirmation ?? detectToolsRequiringConfirmation(tools);

  // Dev-mode warning for mismatched clientTools and tools (only warn once per tool)
  const warnedToolsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (
      process.env.NODE_ENV === "development" &&
      clientTools?.length &&
      tools
    ) {
      for (const ct of clientTools) {
        if (!tools[ct.name] && !warnedToolsRef.current.has(ct.name)) {
          warnedToolsRef.current.add(ct.name);
          console.warn(
            `[useAgentChat] clientTool "${ct.name}" has no matching execute handler in tools. ` +
              `The server may request this tool but the client won't be able to execute it.`
          );
        }
      }
    }
  }, [clientTools, tools]);

  const agentUrl = new URL(
    `${// @ts-expect-error we're using a protected _url property that includes query params
    ((agent._url as string | null) || agent._pkurl)
      ?.replace("ws://", "http://")
      .replace("wss://", "https://")}`
  );

  agentUrl.searchParams.delete("_pk");
  const agentUrlString = agentUrl.toString();

  // we need to include agent.name in cache key to prevent collisions during agent switching.
  // The URL may be stale between updateProperties() and reconnect(), but agent.name
  // is updated synchronously, so each thread gets its own cache entry
  const initialMessagesCacheKey = `${agentUrlString}|${agent.agent ?? ""}|${agent.name ?? ""}`;

  // Keep a ref to always point to the latest agent instance
  const agentRef = useRef(agent);
  useEffect(() => {
    agentRef.current = agent;
  }, [agent]);

  async function defaultGetInitialMessagesFetch({
    url
  }: GetInitialMessagesOptions) {
    const getMessagesUrl = new URL(url);
    getMessagesUrl.pathname += "/get-messages";
    const response = await fetch(getMessagesUrl.toString(), {
      credentials: options.credentials,
      headers: options.headers
    });

    if (!response.ok) {
      console.warn(
        `Failed to fetch initial messages: ${response.status} ${response.statusText}`
      );
      return [];
    }

    const text = await response.text();
    if (!text.trim()) {
      return [];
    }

    try {
      return JSON.parse(text) as ChatMessage[];
    } catch (error) {
      console.warn("Failed to parse initial messages JSON:", error);
      return [];
    }
  }

  const getInitialMessagesFetch =
    getInitialMessages || defaultGetInitialMessagesFetch;

  function doGetInitialMessages(
    getInitialMessagesOptions: GetInitialMessagesOptions,
    cacheKey: string
  ) {
    if (requestCache.has(cacheKey)) {
      return requestCache.get(cacheKey)! as Promise<ChatMessage[]>;
    }
    const promise = getInitialMessagesFetch(getInitialMessagesOptions);
    requestCache.set(cacheKey, promise);
    return promise;
  }

  const initialMessagesPromise =
    getInitialMessages === null
      ? null
      : doGetInitialMessages(
          {
            agent: agent.agent,
            name: agent.name,
            url: agentUrlString
          },
          initialMessagesCacheKey
        );
  const initialMessages = initialMessagesPromise
    ? use(initialMessagesPromise)
    : (optionsInitialMessages ?? []);

  useEffect(() => {
    if (!initialMessagesPromise) {
      return;
    }
    requestCache.set(initialMessagesCacheKey, initialMessagesPromise!);
    return () => {
      if (
        requestCache.get(initialMessagesCacheKey) === initialMessagesPromise
      ) {
        requestCache.delete(initialMessagesCacheKey);
      }
    };
  }, [initialMessagesCacheKey, initialMessagesPromise]);

  const aiFetch = useCallback(
    async (request: RequestInfo | URL, options: RequestInit = {}) => {
      const {
        method,
        keepalive,
        headers,
        body,
        redirect,
        integrity,
        signal,
        credentials,
        mode,
        referrer,
        referrerPolicy,
        window
      } = options;
      const id = nanoid(8);
      const abortController = new AbortController();
      let controller: ReadableStreamDefaultController;
      const currentAgent = agentRef.current;

      // Track this request ID so the onAgentMessage handler knows to skip it
      // (this tab's aiFetch listener handles its own stream)
      localRequestIdsRef.current.add(id);

      signal?.addEventListener("abort", () => {
        currentAgent.send(
          JSON.stringify({
            id,
            type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL
          })
        );

        // NOTE - If we wanted to, we could preserve the "interrupted" message here, with the code below
        //        However, I think it might be the responsibility of the library user to implement that behavior manually?
        //        Reasoning: This code could be subject to collisions, as it "force saves" the messages we have locally
        //
        // agent.send(JSON.stringify({
        //   type: MessageType.CF_AGENT_CHAT_MESSAGES,
        //   messages: ... /* some way of getting current messages ref? */
        // }))
        abortController.abort();
        // Make sure to also close the stream (cf. https://github.com/cloudflare/agents-starter/issues/69)
        try {
          controller.close();
        } catch {
          // Stream may already be errored or closed
        }
        // Clean up the request ID tracking
        localRequestIdsRef.current.delete(id);
      });

      currentAgent.addEventListener(
        "message",
        (event) => {
          let data: OutgoingMessage<ChatMessage>;
          try {
            data = JSON.parse(event.data) as OutgoingMessage<ChatMessage>;
          } catch (_error) {
            // silently ignore invalid messages for now
            // TODO: log errors with log levels
            return;
          }
          if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE) {
            if (data.id === id) {
              if (data.error) {
                controller.error(new Error(data.body));
                abortController.abort();
                // Clean up the request ID tracking
                localRequestIdsRef.current.delete(id);
              } else {
                // Only enqueue non-empty data to prevent JSON parsing errors
                if (data.body?.trim()) {
                  controller.enqueue(
                    new TextEncoder().encode(`data: ${data.body}\n\n`)
                  );
                }
                if (data.done) {
                  try {
                    controller.close();
                  } catch {
                    // Stream may already be errored or closed
                  }
                  abortController.abort();
                  // Clean up the request ID tracking
                  localRequestIdsRef.current.delete(id);
                }
              }
            }
          }
        },
        { signal: abortController.signal }
      );

      const stream = new ReadableStream({
        start(c) {
          controller = c;
        },
        cancel(reason?: unknown) {
          console.warn(
            "[agents/ai-react] cancelling stream",
            id,
            reason || "no reason"
          );
        }
      });

      currentAgent.send(
        JSON.stringify({
          id,
          init: {
            body,
            credentials,
            headers,
            integrity,
            keepalive,
            method,
            mode,
            redirect,
            referrer,
            referrerPolicy,
            window
          },
          type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
          url: request.toString()
        })
      );

      return new Response(stream);
    },
    []
  );

  // Store clientTools and prepareSendMessagesRequest in refs to avoid recreating transport on every render
  const clientToolsRef = useRef(clientTools);
  useEffect(() => {
    clientToolsRef.current = clientTools;
  }, [clientTools]);

  const prepareSendMessagesRequestRef = useRef(prepareSendMessagesRequest);
  useEffect(() => {
    prepareSendMessagesRequestRef.current = prepareSendMessagesRequest;
  }, [prepareSendMessagesRequest]);

  const customTransport: ChatTransport<ChatMessage> = useMemo(
    () => ({
      sendMessages: async (
        sendMessageOptions: Parameters<
          typeof DefaultChatTransport.prototype.sendMessages
        >[0]
      ) => {
        const combinedPrepare =
          clientToolsRef.current?.length ||
          prepareSendMessagesRequestRef.current
            ? async (
                prepareOptions: PrepareSendMessagesRequestOptions<ChatMessage>
              ): Promise<InternalPrepareResult> => {
                // Start with clientTools in the body (or empty body)
                let body: Record<string, unknown> = {};
                let headers: HeadersInit | undefined;
                let credentials: RequestCredentials | undefined;
                let api: string | undefined;

                if (clientToolsRef.current?.length) {
                  body = { clientTools: clientToolsRef.current };
                }

                // Apply prepareSendMessagesRequest callback
                if (prepareSendMessagesRequestRef.current) {
                  const userResult =
                    await prepareSendMessagesRequestRef.current(prepareOptions);

                  // user's callback can override or extend
                  headers = userResult.headers;
                  credentials = userResult.credentials;
                  api = userResult.api;
                  body = {
                    ...body,
                    ...(userResult.body ?? {})
                  };
                }

                return { body, headers, credentials, api };
              }
            : undefined;

        const transport = new DefaultChatTransport<ChatMessage>({
          api: agentUrlString,
          fetch: aiFetch,
          prepareSendMessagesRequest: combinedPrepare
        });
        return transport.sendMessages(sendMessageOptions);
      },
      reconnectToStream: async () => null
    }),
    [agentUrlString, aiFetch]
  );

  const useChatHelpers = useChat<ChatMessage>({
    ...rest,
    messages: initialMessages,
    transport: customTransport,
    id: agent._pk
    // Note: We handle stream resumption via WebSocket instead of HTTP,
    // so we don't pass 'resume' to useChat. The onStreamResuming handler
    // automatically resumes active streams when the WebSocket reconnects.
  });

  const processedToolCalls = useRef(new Set<string>());

  // Fix for issue #728: Track client-side tool results in local state
  // to ensure tool parts show output-available immediately after execution
  const [clientToolResults, setClientToolResults] = useState<
    Map<string, unknown>
  >(new Map());

  // Calculate pending confirmations for the latest assistant message
  const lastMessage =
    useChatHelpers.messages[useChatHelpers.messages.length - 1];

  const pendingConfirmations = (() => {
    if (!lastMessage || lastMessage.role !== "assistant") {
      return { messageId: undefined, toolCallIds: new Set<string>() };
    }

    const pendingIds = new Set<string>();
    for (const part of lastMessage.parts ?? []) {
      if (
        isToolUIPart(part) &&
        part.state === "input-available" &&
        toolsRequiringConfirmation.includes(getToolName(part))
      ) {
        pendingIds.add(part.toolCallId);
      }
    }
    return { messageId: lastMessage.id, toolCallIds: pendingIds };
  })();

  const pendingConfirmationsRef = useRef(pendingConfirmations);
  pendingConfirmationsRef.current = pendingConfirmations;

  // tools can be a different object everytime it's called,
  // which might lead to this effect being called multiple times with different tools objects.
  // we need to fix this, but that's a bigger refactor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: we need to fix this
  useEffect(() => {
    if (!experimental_automaticToolResolution) {
      return;
    }

    const lastMessage =
      useChatHelpers.messages[useChatHelpers.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") {
      return;
    }

    const toolCalls = lastMessage.parts.filter(
      (part) =>
        isToolUIPart(part) &&
        part.state === "input-available" &&
        !processedToolCalls.current.has(part.toolCallId)
    );

    if (toolCalls.length > 0) {
      (async () => {
        const toolCallsToResolve = toolCalls.filter(
          (part) =>
            isToolUIPart(part) &&
            !toolsRequiringConfirmation.includes(getToolName(part)) &&
            tools?.[getToolName(part)]?.execute // Only execute if client has execute function
        );

        if (toolCallsToResolve.length > 0) {
          // Collect all tool results to apply in a single state update
          const toolResults: Array<{
            toolCallId: string;
            toolName: string;
            output: unknown;
          }> = [];

          for (const part of toolCallsToResolve) {
            if (isToolUIPart(part)) {
              processedToolCalls.current.add(part.toolCallId);
              let toolOutput: unknown = null;
              const toolName = getToolName(part);
              const tool = tools?.[toolName];

              if (tool?.execute && part.input) {
                try {
                  toolOutput = await tool.execute(part.input);
                } catch (error) {
                  toolOutput = `Error executing tool: ${error instanceof Error ? error.message : String(error)}`;
                }
              }

              toolResults.push({
                toolCallId: part.toolCallId,
                toolName,
                output: toolOutput
              });
            }
          }

          // Fix for issue #728: Track tool results in local state to ensure tool parts
          // show output-available immediately after client-side execution
          if (toolResults.length > 0) {
            // First, call AI SDK's addToolResult for all results (awaited sequentially)
            // to ensure SDK state is updated before we trigger our own state update
            for (const result of toolResults) {
              await useChatHelpers.addToolResult({
                tool: result.toolName,
                toolCallId: result.toolCallId,
                output: result.output
              });
            }

            // Then batch update local state for immediate UI feedback
            setClientToolResults((prev) => {
              const newMap = new Map(prev);
              for (const result of toolResults) {
                newMap.set(result.toolCallId, result.output);
              }
              return newMap;
            });
          }

          // If there are NO pending confirmations for the latest assistant message,
          // we can continue the conversation. Otherwise, wait for the UI to resolve
          // those confirmations; the addToolResult wrapper will send when the last
          // pending confirmation is resolved.
          if (pendingConfirmationsRef.current.toolCallIds.size === 0) {
            useChatHelpers.sendMessage();
          }
        }
      })();
    }
  }, [
    useChatHelpers.messages,
    experimental_automaticToolResolution,
    useChatHelpers.addToolResult,
    useChatHelpers.sendMessage,
    toolsRequiringConfirmation
  ]);

  /**
   * Contains the request ID, accumulated message parts, and a unique message ID.
   * Used for both resumed streams and real-time broadcasts from other tabs.
   */
  const activeStreamRef = useRef<{
    id: string;
    messageId: string;
    parts: ChatMessage["parts"];
  } | null>(null);

  /**
   * Tracks request IDs initiated by this tab via aiFetch.
   * Used to distinguish local requests from broadcasts.
   */
  const localRequestIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    /**
     * Unified message handler that parses JSON once and dispatches based on type.
     * Avoids duplicate parsing overhead from separate listeners.
     */
    function onAgentMessage(event: MessageEvent) {
      if (typeof event.data !== "string") return;

      let data: OutgoingMessage<ChatMessage>;
      try {
        data = JSON.parse(event.data) as OutgoingMessage<ChatMessage>;
      } catch (_error) {
        return;
      }

      switch (data.type) {
        case MessageType.CF_AGENT_CHAT_CLEAR:
          useChatHelpers.setMessages([]);
          break;

        case MessageType.CF_AGENT_CHAT_MESSAGES:
          useChatHelpers.setMessages(data.messages);
          break;

        case MessageType.CF_AGENT_STREAM_RESUMING:
          if (!resume) return;
          // Clear any previous incomplete active stream to prevent memory leak
          activeStreamRef.current = null;
          // Initialize active stream state with unique ID
          activeStreamRef.current = {
            id: data.id,
            messageId: nanoid(),
            parts: []
          };
          // Send ACK to server - we're ready to receive chunks
          agentRef.current.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
              id: data.id
            })
          );
          break;

        case MessageType.CF_AGENT_USE_CHAT_RESPONSE: {
          // Skip if this is a response to a request this tab initiated
          // (handled by the aiFetch listener instead)
          if (localRequestIdsRef.current.has(data.id)) return;

          // Initialize stream state for broadcasts from other tabs
          if (
            !activeStreamRef.current ||
            activeStreamRef.current.id !== data.id
          ) {
            activeStreamRef.current = {
              id: data.id,
              messageId: nanoid(),
              parts: []
            };
          }

          const activeMsg = activeStreamRef.current;

          if (data.body?.trim()) {
            try {
              const chunkData = JSON.parse(data.body);

              // Handle all chunk types for complete message reconstruction
              switch (chunkData.type) {
                case "text-start": {
                  activeMsg.parts.push({
                    type: "text",
                    text: "",
                    state: "streaming"
                  });
                  break;
                }
                case "text-delta": {
                  const lastTextPart = [...activeMsg.parts]
                    .reverse()
                    .find((p) => p.type === "text");
                  if (lastTextPart && lastTextPart.type === "text") {
                    lastTextPart.text += chunkData.delta;
                  } else {
                    // Handle plain text responses (no text-start)
                    activeMsg.parts.push({
                      type: "text",
                      text: chunkData.delta
                    });
                  }
                  break;
                }
                case "text-end": {
                  const lastTextPart = [...activeMsg.parts]
                    .reverse()
                    .find((p) => p.type === "text");
                  if (lastTextPart && "state" in lastTextPart) {
                    lastTextPart.state = "done";
                  }
                  break;
                }
                case "reasoning-start": {
                  activeMsg.parts.push({
                    type: "reasoning",
                    text: "",
                    state: "streaming"
                  });
                  break;
                }
                case "reasoning-delta": {
                  const lastReasoningPart = [...activeMsg.parts]
                    .reverse()
                    .find((p) => p.type === "reasoning");
                  if (
                    lastReasoningPart &&
                    lastReasoningPart.type === "reasoning"
                  ) {
                    lastReasoningPart.text += chunkData.delta;
                  }
                  break;
                }
                case "reasoning-end": {
                  const lastReasoningPart = [...activeMsg.parts]
                    .reverse()
                    .find((p) => p.type === "reasoning");
                  if (lastReasoningPart && "state" in lastReasoningPart) {
                    lastReasoningPart.state = "done";
                  }
                  break;
                }
                case "file": {
                  activeMsg.parts.push({
                    type: "file",
                    mediaType: chunkData.mediaType,
                    url: chunkData.url
                  });
                  break;
                }
                case "source-url": {
                  activeMsg.parts.push({
                    type: "source-url",
                    sourceId: chunkData.sourceId,
                    url: chunkData.url,
                    title: chunkData.title
                  });
                  break;
                }
                case "source-document": {
                  activeMsg.parts.push({
                    type: "source-document",
                    sourceId: chunkData.sourceId,
                    mediaType: chunkData.mediaType,
                    title: chunkData.title,
                    filename: chunkData.filename
                  });
                  break;
                }
                case "tool-input-available": {
                  // Add tool call part when input is available
                  activeMsg.parts.push({
                    type: `tool-${chunkData.toolName}`,
                    toolCallId: chunkData.toolCallId,
                    toolName: chunkData.toolName,
                    state: "input-available",
                    input: chunkData.input
                  } as ChatMessage["parts"][number]);
                  break;
                }
                case "tool-output-available": {
                  // Update existing tool part with output using immutable pattern
                  const toolPartIndex = activeMsg.parts.findIndex(
                    (p) =>
                      "toolCallId" in p && p.toolCallId === chunkData.toolCallId
                  );
                  if (toolPartIndex !== -1) {
                    const existingPart = activeMsg.parts[toolPartIndex];
                    if ("state" in existingPart) {
                      activeMsg.parts[toolPartIndex] = {
                        ...existingPart,
                        state: "output-available",
                        output: chunkData.output
                      } as ChatMessage["parts"][number];
                    }
                  }
                  break;
                }
                case "step-start": {
                  activeMsg.parts.push({ type: "step-start" });
                  break;
                }
                // Other chunk types (tool-input-start, tool-input-delta, etc.)
                // are intermediate states - the final state will be captured above
              }

              // Update messages with the partial response
              useChatHelpers.setMessages((prevMessages: ChatMessage[]) => {
                if (!activeMsg) return prevMessages;

                const existingIdx = prevMessages.findIndex(
                  (m) => m.id === activeMsg.messageId
                );

                const partialMessage = {
                  id: activeMsg.messageId,
                  role: "assistant" as const,
                  parts: [...activeMsg.parts]
                } as unknown as ChatMessage;

                if (existingIdx >= 0) {
                  const updated = [...prevMessages];
                  updated[existingIdx] = partialMessage;
                  return updated;
                }
                return [...prevMessages, partialMessage];
              });
            } catch (parseError) {
              // Log corrupted chunk for debugging - could indicate data loss
              console.warn(
                "[useAgentChat] Failed to parse stream chunk:",
                parseError instanceof Error ? parseError.message : parseError,
                "body:",
                data.body?.slice(0, 100) // Truncate for logging
              );
            }
          }

          // Clear on completion or error
          if (data.done || data.error) {
            activeStreamRef.current = null;
          }
          break;
        }
      }
    }

    agent.addEventListener("message", onAgentMessage);
    return () => {
      agent.removeEventListener("message", onAgentMessage);
      // Clear active stream state on cleanup to prevent memory leak
      activeStreamRef.current = null;
    };
  }, [agent, useChatHelpers.setMessages, resume]);

  // Wrapper that sends only when the last pending confirmation is resolved
  const addToolResultAndSendMessage: typeof useChatHelpers.addToolResult =
    async (args) => {
      const { toolCallId } = args;
      const output = "output" in args ? args.output : undefined;

      // Fix for issue #728: Track tool result in local state to ensure
      // the tool part shows output-available immediately
      setClientToolResults((prev) => new Map(prev).set(toolCallId, output));

      // Also call AI SDK's addToolResult for compatibility
      await useChatHelpers.addToolResult(args);

      if (!autoSendAfterAllConfirmationsResolved) {
        // always send immediately
        useChatHelpers.sendMessage();
        return;
      }

      // wait for all confirmations
      const pending = pendingConfirmationsRef.current?.toolCallIds;
      if (!pending) {
        useChatHelpers.sendMessage();
        return;
      }

      const wasLast = pending.size === 1 && pending.has(toolCallId);
      if (pending.has(toolCallId)) {
        pending.delete(toolCallId);
      }

      if (wasLast || pending.size === 0) {
        useChatHelpers.sendMessage();
      }
    };

  // Fix for issue #728: Merge client-side tool results with messages
  // so tool parts show output-available immediately after execution
  const messagesWithToolResults = useMemo(() => {
    if (clientToolResults.size === 0) {
      return useChatHelpers.messages;
    }
    return useChatHelpers.messages.map((msg) => ({
      ...msg,
      parts: msg.parts.map((p) => {
        // Only modify tool parts that have both toolCallId and state fields
        // This ensures type safety - only ToolUIPart-like objects are modified
        if (
          !("toolCallId" in p) ||
          !("state" in p) ||
          !clientToolResults.has(p.toolCallId)
        ) {
          return p;
        }
        return {
          ...p,
          state: "output-available" as const,
          output: clientToolResults.get(p.toolCallId)
        };
      })
    })) as ChatMessage[];
  }, [useChatHelpers.messages, clientToolResults]);

  // Cleanup stale entries from clientToolResults when messages change
  // to prevent memory leak in long conversations
  useEffect(() => {
    if (clientToolResults.size === 0) return;

    // Collect all current toolCallIds from messages
    const currentToolCallIds = new Set<string>();
    for (const msg of useChatHelpers.messages) {
      for (const part of msg.parts) {
        if ("toolCallId" in part && part.toolCallId) {
          currentToolCallIds.add(part.toolCallId);
        }
      }
    }

    // Check if any entries in clientToolResults are stale
    let hasStaleEntries = false;
    for (const toolCallId of clientToolResults.keys()) {
      if (!currentToolCallIds.has(toolCallId)) {
        hasStaleEntries = true;
        break;
      }
    }

    // Only update state if there are stale entries to remove
    if (hasStaleEntries) {
      setClientToolResults((prev) => {
        const newMap = new Map<string, unknown>();
        for (const [id, output] of prev) {
          if (currentToolCallIds.has(id)) {
            newMap.set(id, output);
          }
        }
        return newMap;
      });
    }
  }, [useChatHelpers.messages, clientToolResults]);

  return {
    ...useChatHelpers,
    messages: messagesWithToolResults,
    addToolResult: addToolResultAndSendMessage,
    clearHistory: () => {
      useChatHelpers.setMessages([]);
      setClientToolResults(new Map());
      processedToolCalls.current.clear();
      agent.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_CHAT_CLEAR
        })
      );
    },
    setMessages: (
      messages: Parameters<typeof useChatHelpers.setMessages>[0]
    ) => {
      useChatHelpers.setMessages(messages);
      agent.send(
        JSON.stringify({
          messages: Array.isArray(messages) ? messages : [],
          type: MessageType.CF_AGENT_CHAT_MESSAGES
        })
      );
    }
  };
}
