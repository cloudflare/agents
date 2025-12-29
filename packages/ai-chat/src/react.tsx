import { useChat, type UseChatOptions } from "@ai-sdk/react";
import { getToolName, isToolUIPart } from "ai";
import type {
  ChatInit,
  ChatTransport,
  JSONSchema7,
  Tool,
  UIMessage as Message,
  UIMessage
} from "ai";
import { DefaultChatTransport } from "ai";
import { nanoid } from "nanoid";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OutgoingMessage } from "./types";
import { MessageType } from "./types";
import type { useAgent } from "agents/react";

/**
 * JSON Schema type for tool parameters.
 * Re-exported from the AI SDK for convenience.
 * @deprecated Import JSONSchema7 directly from "ai" instead.
 */
export type JSONSchemaType = JSONSchema7;

/**
 * Definition for a tool that can be executed on the client.
 * Tools with an `execute` function are automatically registered with the server.
 *
 * Note: Uses `parameters` (JSONSchema7) rather than AI SDK's `inputSchema` (FlexibleSchema)
 * because client tools must be serializable for the wire format. Zod schemas cannot be
 * serialized, so we require raw JSON Schema here.
 *
 * @deprecated Use AI SDK's native tool pattern instead. Define tools on the server with
 * `tool()` from "ai", and handle client-side execution via the `onToolCall` callback
 * in `useAgentChat`. For tools requiring user approval, use `needsApproval` on the server.
 */
export type AITool<Input = unknown, Output = unknown> = {
  /** Human-readable description of what the tool does */
  description?: Tool["description"];
  /** JSON Schema defining the tool's input parameters */
  parameters?: JSONSchema7;
  /**
   * @deprecated Use `parameters` instead. Will be removed in a future version.
   */
  inputSchema?: JSONSchema7;
  /**
   * Function to execute the tool on the client.
   * If provided, the tool schema is automatically sent to the server.
   */
  execute?: (input: Input) => Output | Promise<Output>;
};

/**
 * Schema for a client tool sent to the server.
 * This is the wire format - what gets sent in the request body.
 * Must match the server-side ClientToolSchema type in ai-chat-agent.ts.
 *
 * @deprecated Use AI SDK's native tool pattern instead. Define tools on the server.
 */
export type ClientToolSchema = {
  /** Unique name for the tool */
  name: string;
  /** Human-readable description of what the tool does */
  description?: Tool["description"];
  /** JSON Schema defining the tool's input parameters */
  parameters?: JSONSchema7;
};

/**
 * Extracts tool schemas from tools that have client-side execute functions.
 * These schemas are automatically sent to the server with each request.
 * @param tools - Record of tool name to tool definition
 * @returns Array of tool schemas to send to server, or undefined if none
 *
 * @deprecated Use AI SDK's native tool pattern instead. Define tools on the server
 * and use `onToolCall` callback for client-side execution.
 */
export function extractClientToolSchemas(
  tools?: Record<string, AITool<unknown, unknown>>
): ClientToolSchema[] | undefined {
  if (!tools) return undefined;

  const schemas: ClientToolSchema[] = Object.entries(tools)
    .filter(([_, tool]) => tool.execute) // Only tools with client-side execute
    .map(([name, tool]) => {
      if (tool.inputSchema && !tool.parameters) {
        console.warn(
          `[useAgentChat] Tool "${name}" uses deprecated 'inputSchema'. Please migrate to 'parameters'.`
        );
      }
      return {
        name,
        description: tool.description,
        parameters: tool.parameters ?? tool.inputSchema
      };
    });

  return schemas.length > 0 ? schemas : undefined;
}

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
 * Callback for handling client-side tool execution.
 * Called when a tool without server-side execute is invoked.
 */
export type OnToolCallCallback = (options: {
  /** The tool call that needs to be handled */
  toolCall: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  };
  /** Function to provide the tool output */
  addToolOutput: (options: { toolCallId: string; output: unknown }) => void;
}) => void | Promise<void>;

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
   * Callback for handling client-side tool execution.
   * Called when a tool without server-side `execute` is invoked by the LLM.
   *
   * Use this for:
   * - Tools that need browser APIs (geolocation, camera, etc.)
   * - Tools that need user interaction before providing a result
   * - Tools requiring approval before execution
   *
   * @example
   * ```typescript
   * onToolCall: async ({ toolCall, addToolOutput }) => {
   *   if (toolCall.toolName === 'getLocation') {
   *     const position = await navigator.geolocation.getCurrentPosition();
   *     addToolOutput({
   *       toolCallId: toolCall.toolCallId,
   *       output: { lat: position.coords.latitude, lng: position.coords.longitude }
   *     });
   *   }
   * }
   * ```
   */
  onToolCall?: OnToolCallCallback;
  /**
   * @deprecated Use `onToolCall` callback instead for automatic tool execution.
   * @description Whether to automatically resolve tool calls that do not require human interaction.
   * @experimental
   */
  experimental_automaticToolResolution?: boolean;
  /**
   * @deprecated Use `onToolCall` callback instead. Define tools on the server
   * and handle client-side execution via `onToolCall`.
   *
   * Tools that can be executed on the client.
   */
  tools?: Record<string, AITool<unknown, unknown>>;
  /**
   * @deprecated Use `needsApproval` on server-side tools instead.
   * @description Manual override for tools requiring confirmation.
   * If not provided, will auto-detect from tools object (tools without execute require confirmation).
   */
  toolsRequiringConfirmation?: string[];
  /**
   * When true, the server automatically continues the conversation after
   * receiving client-side tool results, similar to how server-executed tools
   * work with maxSteps in streamText. The continuation is merged into the
   * same assistant message.
   *
   * When false (default), the client calls sendMessage() after tool results
   * to continue the conversation, which creates a new assistant message.
   *
   * @default false
   */
  autoContinueAfterToolResult?: boolean;
  /**
   * @deprecated Use `sendAutomaticallyWhen` from AI SDK instead.
   *
   * When true (default), automatically sends the next message only after
   * all pending confirmation-required tool calls have been resolved.
   * When false, sends immediately after each tool result.
   *
   * Only applies when `autoContinueAfterToolResult` is false.
   *
   * @default true
   */
  autoSendAfterAllConfirmationsResolved?: boolean;
  /**
   * Set to false to disable automatic stream resumption.
   * @default true
   */
  resume?: boolean;
  /**
   * Callback to customize the request before sending messages.
   * Use this for advanced scenarios like adding custom headers or dynamic context.
   *
   * Note: Client tool schemas are automatically sent when tools have `execute` functions.
   * This callback can add additional data alongside the auto-extracted schemas.
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
 *
 * @deprecated Use `needsApproval` on server-side tools instead.
 */
export function detectToolsRequiringConfirmation(
  tools?: Record<string, AITool<unknown, unknown>>
): string[] {
  if (!tools) return [];

  return Object.entries(tools)
    .filter(([_name, tool]) => !tool.execute)
    .map(([name]) => name);
}

/**
 * Return type for addToolOutput function
 */
type AddToolOutputOptions = {
  /** The ID of the tool call to provide output for */
  toolCallId: string;
  /** The name of the tool (optional, for type safety) */
  toolName?: string;
  /** The output to provide */
  output: unknown;
};

export function useAgentChat<
  State = unknown,
  ChatMessage extends UIMessage = UIMessage
>(
  options: UseAgentChatOptions<State, ChatMessage>
): Omit<ReturnType<typeof useChat<ChatMessage>>, "addToolOutput"> & {
  clearHistory: () => void;
  /**
   * Provide output for a tool call. Use this for tools that require user interaction
   * or client-side execution.
   */
  addToolOutput: (opts: AddToolOutputOptions) => void;
} {
  const {
    agent,
    getInitialMessages,
    messages: optionsInitialMessages,
    onToolCall,
    experimental_automaticToolResolution,
    tools,
    toolsRequiringConfirmation: manualToolsRequiringConfirmation,
    autoContinueAfterToolResult = false, // Opt-in to server auto-continuation
    autoSendAfterAllConfirmationsResolved = true, // Legacy option for client-side batching
    resume = true, // Enable stream resumption by default
    prepareSendMessagesRequest,
    ...rest
  } = options;

  // Auto-detect tools requiring confirmation, or use manual override
  // @deprecated - this will be removed when toolsRequiringConfirmation is removed
  const toolsRequiringConfirmation =
    manualToolsRequiringConfirmation ?? detectToolsRequiringConfirmation(tools);

  // Keep a ref to always point to the latest onToolCall callback
  const onToolCallRef = useRef(onToolCall);
  onToolCallRef.current = onToolCall;

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
            "[@cloudflare/ai-chat/react] cancelling stream",
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

  // Use synchronous ref updates to avoid race conditions between effect runs.
  // This ensures the ref always has the latest value before any effect reads it.
  const toolsRef = useRef(tools);
  toolsRef.current = tools;

  const prepareSendMessagesRequestRef = useRef(prepareSendMessagesRequest);
  prepareSendMessagesRequestRef.current = prepareSendMessagesRequest;

  const customTransport: ChatTransport<ChatMessage> = useMemo(
    () => ({
      sendMessages: async (
        sendMessageOptions: Parameters<
          typeof DefaultChatTransport.prototype.sendMessages
        >[0]
      ) => {
        // Extract schemas from tools with execute functions
        const clientToolSchemas = extractClientToolSchemas(toolsRef.current);

        const combinedPrepare =
          clientToolSchemas || prepareSendMessagesRequestRef.current
            ? async (
                prepareOptions: PrepareSendMessagesRequestOptions<ChatMessage>
              ): Promise<InternalPrepareResult> => {
                // Start with auto-extracted client tool schemas
                let body: Record<string, unknown> = {};
                let headers: HeadersInit | undefined;
                let credentials: RequestCredentials | undefined;
                let api: string | undefined;

                if (clientToolSchemas) {
                  body = {
                    id: prepareOptions.id,
                    messages: prepareOptions.messages,
                    trigger: prepareOptions.trigger,
                    clientTools: clientToolSchemas
                  };
                }

                // Apply prepareSendMessagesRequest callback for additional customization
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
  const isResolvingToolsRef = useRef(false);

  // Fix for issue #728: Track client-side tool results in local state
  // to ensure tool parts show output-available immediately after execution.
  const [clientToolResults, setClientToolResults] = useState<
    Map<string, unknown>
  >(new Map());

  // Ref to access current messages in callbacks without stale closures
  const messagesRef = useRef(useChatHelpers.messages);
  messagesRef.current = useChatHelpers.messages;

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

  // Automatic tool resolution effect.
  useEffect(() => {
    if (!experimental_automaticToolResolution) {
      return;
    }

    // Prevent re-entry while async operations are in progress
    if (isResolvingToolsRef.current) {
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
      // Capture tools synchronously before async work
      const currentTools = toolsRef.current;
      const toolCallsToResolve = toolCalls.filter(
        (part) =>
          isToolUIPart(part) &&
          !toolsRequiringConfirmation.includes(getToolName(part)) &&
          currentTools?.[getToolName(part)]?.execute
      );

      if (toolCallsToResolve.length > 0) {
        isResolvingToolsRef.current = true;

        (async () => {
          try {
            const toolResults: Array<{
              toolCallId: string;
              toolName: string;
              output: unknown;
            }> = [];

            for (const part of toolCallsToResolve) {
              if (isToolUIPart(part)) {
                let toolOutput: unknown = null;
                const toolName = getToolName(part);
                const tool = currentTools?.[toolName];

                if (tool?.execute && part.input !== undefined) {
                  try {
                    toolOutput = await tool.execute(part.input);
                  } catch (error) {
                    toolOutput = `Error executing tool: ${error instanceof Error ? error.message : String(error)}`;
                  }
                }

                processedToolCalls.current.add(part.toolCallId);

                toolResults.push({
                  toolCallId: part.toolCallId,
                  toolName,
                  output: toolOutput
                });
              }
            }

            if (toolResults.length > 0) {
              // Send tool results to server first (server is source of truth)
              for (const result of toolResults) {
                agentRef.current.send(
                  JSON.stringify({
                    type: MessageType.CF_AGENT_TOOL_RESULT,
                    toolCallId: result.toolCallId,
                    toolName: result.toolName,
                    output: result.output,
                    autoContinue: autoContinueAfterToolResult
                  })
                );
              }

              // Also update local state via AI SDK for immediate UI feedback
              await Promise.all(
                toolResults.map((result) =>
                  useChatHelpers.addToolResult({
                    tool: result.toolName,
                    toolCallId: result.toolCallId,
                    output: result.output
                  })
                )
              );

              setClientToolResults((prev) => {
                const newMap = new Map(prev);
                for (const result of toolResults) {
                  newMap.set(result.toolCallId, result.output);
                }
                return newMap;
              });
            }

            // Note: We don't call sendMessage() here anymore.
            // The server will continue the conversation after applying tool results.
          } finally {
            isResolvingToolsRef.current = false;
          }
        })();
      }
    }
  }, [
    useChatHelpers.messages,
    experimental_automaticToolResolution,
    useChatHelpers.addToolResult,
    toolsRequiringConfirmation,
    autoContinueAfterToolResult
  ]);

  // Helper function to send tool output to server
  const sendToolOutputToServer = useCallback(
    (toolCallId: string, toolName: string, output: unknown) => {
      agentRef.current.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_TOOL_RESULT,
          toolCallId,
          toolName,
          output,
          autoContinue: autoContinueAfterToolResult
        })
      );

      setClientToolResults((prev) => new Map(prev).set(toolCallId, output));
    },
    [autoContinueAfterToolResult]
  );

  // Effect for new onToolCall callback pattern (v6 style)
  // This fires when there are tool calls that need client-side handling
  useEffect(() => {
    const currentOnToolCall = onToolCallRef.current;
    if (!currentOnToolCall) {
      return;
    }

    const lastMessage =
      useChatHelpers.messages[useChatHelpers.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") {
      return;
    }

    // Find tool calls in input-available state that haven't been processed
    const pendingToolCalls = lastMessage.parts.filter(
      (part) =>
        isToolUIPart(part) &&
        part.state === "input-available" &&
        !processedToolCalls.current.has(part.toolCallId)
    );

    for (const part of pendingToolCalls) {
      if (isToolUIPart(part)) {
        const toolCallId = part.toolCallId;
        const toolName = getToolName(part);

        // Mark as processed to prevent re-triggering
        processedToolCalls.current.add(toolCallId);

        // Create addToolOutput function for this specific tool call
        const addToolOutput = (opts: {
          toolCallId: string;
          output: unknown;
        }) => {
          sendToolOutputToServer(opts.toolCallId, toolName, opts.output);

          // Update local state via AI SDK
          useChatHelpers.addToolResult({
            tool: toolName,
            toolCallId: opts.toolCallId,
            output: opts.output
          });
        };

        // Call the onToolCall callback
        // The callback is responsible for calling addToolOutput when ready
        currentOnToolCall({
          toolCall: {
            toolCallId,
            toolName,
            input: part.input
          },
          addToolOutput
        });
      }
    }
  }, [
    useChatHelpers.messages,
    sendToolOutputToServer,
    useChatHelpers.addToolResult
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

        case MessageType.CF_AGENT_MESSAGE_UPDATED:
          // Server updated a message (e.g., applied tool result)
          // Update the specific message in local state
          useChatHelpers.setMessages((prevMessages: ChatMessage[]) => {
            const updatedMessage = data.message;

            // First try to find by message ID
            let idx = prevMessages.findIndex((m) => m.id === updatedMessage.id);

            // If not found by ID, try to find by toolCallId
            // This handles the case where client has AI SDK-generated IDs
            // but server has server-generated IDs
            if (idx < 0) {
              const updatedToolCallIds = new Set(
                updatedMessage.parts
                  .filter(
                    (p: ChatMessage["parts"][number]) =>
                      "toolCallId" in p && p.toolCallId
                  )
                  .map(
                    (p: ChatMessage["parts"][number]) =>
                      (p as { toolCallId: string }).toolCallId
                  )
              );

              if (updatedToolCallIds.size > 0) {
                idx = prevMessages.findIndex((m) =>
                  m.parts.some(
                    (p) =>
                      "toolCallId" in p &&
                      updatedToolCallIds.has(
                        (p as { toolCallId: string }).toolCallId
                      )
                  )
                );
              }
            }

            if (idx >= 0) {
              const updated = [...prevMessages];
              // Preserve the client's message ID but update the content
              updated[idx] = {
                ...updatedMessage,
                id: prevMessages[idx].id
              };
              return updated;
            }
            // Message not found, append it
            return [...prevMessages, updatedMessage];
          });
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

          // For continuations, find the last assistant message ID to append to
          const isContinuation = data.continuation === true;

          // Initialize stream state for broadcasts from other tabs
          if (
            !activeStreamRef.current ||
            activeStreamRef.current.id !== data.id
          ) {
            let messageId = nanoid();
            let existingParts: ChatMessage["parts"] = [];

            // For continuations, use the last assistant message's ID and parts
            if (isContinuation) {
              const currentMessages = messagesRef.current;
              for (let i = currentMessages.length - 1; i >= 0; i--) {
                if (currentMessages[i].role === "assistant") {
                  messageId = currentMessages[i].id;
                  existingParts = [...currentMessages[i].parts];
                  break;
                }
              }
            }

            activeStreamRef.current = {
              id: data.id,
              messageId,
              parts: existingParts
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
                  activeMsg.parts = activeMsg.parts.map((p) => {
                    if (
                      "toolCallId" in p &&
                      p.toolCallId === chunkData.toolCallId &&
                      "state" in p
                    ) {
                      return {
                        ...p,
                        state: "output-available",
                        output: chunkData.output
                      } as ChatMessage["parts"][number];
                    }
                    return p;
                  });
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

  // Wrapper that sends tool result to server and optionally continues conversation.
  const addToolResultAndSendMessage: typeof useChatHelpers.addToolResult =
    async (args) => {
      const { toolCallId } = args;
      const toolName = "tool" in args ? args.tool : "";
      const output = "output" in args ? args.output : undefined;

      // Send tool result to server (server is source of truth)
      // Include flag to tell server whether to auto-continue
      agentRef.current.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_TOOL_RESULT,
          toolCallId,
          toolName,
          output,
          autoContinue: autoContinueAfterToolResult
        })
      );

      setClientToolResults((prev) => new Map(prev).set(toolCallId, output));

      // Call AI SDK's addToolResult for local state update (non-blocking)
      // We don't await this since clientToolResults provides immediate UI feedback
      useChatHelpers.addToolResult(args);

      // If server auto-continuation is disabled, client needs to trigger continuation
      if (!autoContinueAfterToolResult) {
        // Use legacy behavior: batch confirmations or send immediately
        if (!autoSendAfterAllConfirmationsResolved) {
          // Always send immediately
          useChatHelpers.sendMessage();
          return;
        }

        // Wait for all confirmations before sending
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
      }
      // If autoContinueAfterToolResult is true, server handles continuation
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
        if (
          !("toolCallId" in p) ||
          !("state" in p) ||
          p.state !== "input-available" ||
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
  // to prevent memory leak in long conversations.
  // Note: We intentionally exclude clientToolResults from deps to avoid infinite loops.
  // The functional update form gives us access to the previous state.
  useEffect(() => {
    // Collect all current toolCallIds from messages
    const currentToolCallIds = new Set<string>();
    for (const msg of useChatHelpers.messages) {
      for (const part of msg.parts) {
        if ("toolCallId" in part && part.toolCallId) {
          currentToolCallIds.add(part.toolCallId);
        }
      }
    }

    // Use functional update to check and clean stale entries atomically
    setClientToolResults((prev) => {
      if (prev.size === 0) return prev;

      // Check if any entries are stale
      let hasStaleEntries = false;
      for (const toolCallId of prev.keys()) {
        if (!currentToolCallIds.has(toolCallId)) {
          hasStaleEntries = true;
          break;
        }
      }

      // Only create new Map if there are stale entries to remove
      if (!hasStaleEntries) return prev;

      const newMap = new Map<string, unknown>();
      for (const [id, output] of prev) {
        if (currentToolCallIds.has(id)) {
          newMap.set(id, output);
        }
      }
      return newMap;
    });

    // Also cleanup processedToolCalls to prevent issues in long conversations
    for (const toolCallId of processedToolCalls.current) {
      if (!currentToolCallIds.has(toolCallId)) {
        processedToolCalls.current.delete(toolCallId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useChatHelpers.messages]);

  // Create addToolOutput function for external use
  const addToolOutput = useCallback(
    (opts: { toolCallId: string; toolName?: string; output: unknown }) => {
      const toolName = opts.toolName ?? "";
      sendToolOutputToServer(opts.toolCallId, toolName, opts.output);

      // Update local state via AI SDK
      useChatHelpers.addToolResult({
        tool: toolName,
        toolCallId: opts.toolCallId,
        output: opts.output
      });
    },
    [sendToolOutputToServer, useChatHelpers.addToolResult]
  );

  return {
    ...useChatHelpers,
    messages: messagesWithToolResults,
    /**
     * Provide output for a tool call. Use this for tools that require user interaction
     * or client-side execution.
     */
    addToolOutput,
    /**
     * @deprecated Use `addToolOutput` instead.
     */
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
