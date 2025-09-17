import { useChat, type UseChatOptions } from "@ai-sdk/react";
import { getToolName, isToolUIPart } from "ai";
import type {
  ChatInit,
  ChatTransport,
  UIMessage as Message,
  UIMessage
} from "ai";
import { DefaultChatTransport } from "ai";
import { use, useEffect, useRef, useState, useCallback } from "react";

export type AITool<Input = unknown, Output = unknown> = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: Input) => Output | Promise<Output>;
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
 * Options for the useAgentChatHttp hook
 */
type UseAgentChatHttpOptions<
  State,
  ChatMessage extends UIMessage = UIMessage
> = Omit<UseChatParams<ChatMessage>, "fetch"> & {
  /** Agent URL for HTTP requests */
  agentUrl: string;
  /** Polling interval for "poke and pull" updates in milliseconds */
  pollingInterval?: number;
  /** Enable resumable streams */
  enableResumableStreams?: boolean;
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
};

const requestCache = new Map<string, Promise<Message[]>>();

/**
 * Stream state for resumable streams
 */
interface StreamState {
  streamId: string;
  position: number;
  completed: boolean;
  lastUpdate: number;
}

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

/**
 * HTTP-based React hook for building AI chat interfaces with resumable streams
 * Uses "poke and pull" pattern instead of WebSockets for real-time updates
 * @param options Chat options including the agent URL
 * @returns Chat interface controls and state with added stream management
 */
export function useAgentChatHttp<
  State = unknown,
  ChatMessage extends UIMessage = UIMessage
>(
  options: UseAgentChatHttpOptions<State, ChatMessage>
): ReturnType<typeof useChat<ChatMessage>> & {
  clearChatHistory: () => Promise<void>;
  activeStreams: StreamState[];
  resumeStream: (streamId: string) => Promise<void>;
  cancelStream: (streamId: string) => Promise<void>;
} {
  const {
    agentUrl,
    pollingInterval = 2000, // Default 2 second polling
    enableResumableStreams = true,
    getInitialMessages,
    messages: optionsInitialMessages,
    experimental_automaticToolResolution,
    tools,
    toolsRequiringConfirmation: manualToolsRequiringConfirmation,
    credentials,
    headers,
    ...rest
  } = options;

  // Auto-detect tools requiring confirmation, or use manual override
  const toolsRequiringConfirmation =
    manualToolsRequiringConfirmation ?? detectToolsRequiringConfirmation(tools);

  const [activeStreams, setActiveStreams] = useState<StreamState[]>([]);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastPollingTime = useRef<number>(0);

  // Normalize agent URL
  const normalizedAgentUrl = agentUrl.replace(/\/$/, ""); // Remove trailing slash

  async function defaultGetInitialMessagesFetch({
    url
  }: GetInitialMessagesOptions) {
    const getMessagesUrl = `${url}/messages`;
    const response = await fetch(getMessagesUrl, {
      credentials,
      headers
    });

    if (!response.ok) {
      console.warn(
        `Failed to fetch initial messages: ${response.status} ${response.statusText}`
      );
      return [];
    }

    const data = (await response.json()) as { messages?: ChatMessage[] };
    return data.messages || [];
  }

  const getInitialMessagesFetch =
    getInitialMessages || defaultGetInitialMessagesFetch;

  function doGetInitialMessages(
    getInitialMessagesOptions: GetInitialMessagesOptions
  ) {
    const cacheKey = `${normalizedAgentUrl}_messages`;
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
      : doGetInitialMessages({
          agent: "http-chat", // Generic agent name for HTTP mode
          name: "http-chat",
          url: normalizedAgentUrl
        });

  const initialMessages = initialMessagesPromise
    ? use(initialMessagesPromise)
    : (optionsInitialMessages ?? []);

  useEffect(() => {
    if (!initialMessagesPromise) {
      return;
    }
    const cacheKey = `${normalizedAgentUrl}_messages`;
    requestCache.set(cacheKey, initialMessagesPromise!);
    return () => {
      if (requestCache.get(cacheKey) === initialMessagesPromise) {
        requestCache.delete(cacheKey);
      }
    };
  }, [normalizedAgentUrl, initialMessagesPromise]);

  /**
   * Custom fetch function for HTTP-based chat
   */
  async function httpChatFetch(
    request: RequestInfo | URL,
    options: RequestInit = {}
  ) {
    const requestUrl = request.toString();
    const chatUrl = `${normalizedAgentUrl}/chat`;

    // Modify the request to use our HTTP endpoint
    const modifiedOptions = {
      ...options,
      credentials,
      headers: {
        ...headers,
        ...options.headers,
        "Content-Type": "application/json"
      }
    };

    const response = await fetch(chatUrl, modifiedOptions);

    if (enableResumableStreams) {
      const streamId = response.headers.get("X-Stream-Id");
      if (streamId) {
        // Track this stream for resumable functionality
        setActiveStreams((prev) => [
          ...prev.filter((s) => s.streamId !== streamId),
          {
            streamId,
            position: 0,
            completed: false,
            lastUpdate: Date.now()
          }
        ]);

        // Start polling for stream updates
        startPolling();
      }
    }

    return response;
  }

  const customTransport: ChatTransport<ChatMessage> = {
    sendMessages: async (
      options: Parameters<typeof DefaultChatTransport.prototype.sendMessages>[0]
    ) => {
      const transport = new DefaultChatTransport<ChatMessage>({
        api: normalizedAgentUrl,
        fetch: httpChatFetch
      });
      return transport.sendMessages(options);
    },
    reconnectToStream: async (
      options: Parameters<
        typeof DefaultChatTransport.prototype.reconnectToStream
      >[0]
    ) => {
      const transport = new DefaultChatTransport<ChatMessage>({
        api: normalizedAgentUrl,
        fetch: httpChatFetch
      });
      return transport.reconnectToStream(options);
    }
  };

  const useChatHelpers = useChat<ChatMessage>({
    ...rest,
    messages: initialMessages,
    transport: customTransport
  });

  /**
   * Stop polling for updates
   */
  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  /**
   * Start polling for updates using "poke and pull" pattern
   */
  const startPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      return; // Already polling
    }

    pollingIntervalRef.current = setInterval(async () => {
      const now = Date.now();

      // Avoid too frequent polling
      if (now - lastPollingTime.current < pollingInterval) {
        return;
      }

      lastPollingTime.current = now;

      try {
        // Check for message updates
        const messagesResponse = await fetch(`${normalizedAgentUrl}/messages`, {
          credentials,
          headers
        });

        if (messagesResponse.ok) {
          const data = (await messagesResponse.json()) as {
            messages?: ChatMessage[];
          };
          const serverMessages = data.messages || [];

          // Update messages if they've changed
          if (
            JSON.stringify(serverMessages) !==
            JSON.stringify(useChatHelpers.messages)
          ) {
            useChatHelpers.setMessages(serverMessages);
          }
        }

        // Check active streams for updates
        let hasActiveStreams = activeStreams.length > 0;

        if (enableResumableStreams && activeStreams.length > 0) {
          const updatedStreams = await Promise.all(
            activeStreams.map(async (stream) => {
              try {
                const statusResponse = await fetch(
                  `${normalizedAgentUrl}/stream/${stream.streamId}/status`,
                  { credentials, headers }
                );

                if (statusResponse.ok) {
                  const status = (await statusResponse.json()) as {
                    position: number;
                    completed: boolean;
                  };
                  return {
                    ...stream,
                    position: status.position,
                    completed: status.completed,
                    lastUpdate: now
                  };
                }
              } catch (error) {
                console.warn(
                  `Failed to check stream ${stream.streamId}:`,
                  error
                );
              }
              return stream;
            })
          );

          const activeUpdatedStreams = updatedStreams.filter(
            (s: StreamState) => !s.completed
          );
          setActiveStreams(activeUpdatedStreams);
          hasActiveStreams = activeUpdatedStreams.length > 0;
        }

        // Stop polling if no active streams
        if (!hasActiveStreams) {
          stopPolling();
        }
      } catch (error) {
        console.warn("Polling error:", error);
      }
    }, pollingInterval);
  }, [
    normalizedAgentUrl,
    pollingInterval,
    credentials,
    headers,
    enableResumableStreams,
    stopPolling
  ]);

  /**
   * Resume an interrupted stream
   */
  const resumeStream = useCallback(
    async (streamId: string) => {
      try {
        const response = await fetch(
          `${normalizedAgentUrl}/stream/${streamId}`,
          {
            credentials,
            headers
          }
        );

        if (response.ok) {
          const content = await response.text();
          console.log(`Resumed stream ${streamId}:`, content);

          // Update stream state
          setActiveStreams((prev) =>
            prev.map((s) =>
              s.streamId === streamId
                ? {
                    ...s,
                    completed:
                      response.headers.get("X-Stream-Complete") === "true"
                  }
                : s
            )
          );
        }
      } catch (error) {
        console.error(`Failed to resume stream ${streamId}:`, error);
      }
    },
    [normalizedAgentUrl, credentials, headers]
  );

  /**
   * Cancel an active stream
   */
  const cancelStream = useCallback(
    async (streamId: string) => {
      try {
        const response = await fetch(
          `${normalizedAgentUrl}/stream/${streamId}/cancel`,
          {
            method: "POST",
            credentials,
            headers
          }
        );

        if (response.ok) {
          setActiveStreams((prev) =>
            prev.filter((s) => s.streamId !== streamId)
          );
        }
      } catch (error) {
        console.error(`Failed to cancel stream ${streamId}:`, error);
      }
    },
    [normalizedAgentUrl, credentials, headers]
  );

  const processedToolCalls = useRef(new Set<string>());

  // Tool resolution logic (same as original useAgentChat)
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
            tools?.[getToolName(part)]?.execute
        );

        if (toolCallsToResolve.length > 0) {
          for (const part of toolCallsToResolve) {
            if (isToolUIPart(part)) {
              processedToolCalls.current.add(part.toolCallId);
              let toolOutput = null;
              const toolName = getToolName(part);
              const tool = tools?.[toolName];

              if (tool?.execute && part.input) {
                try {
                  toolOutput = await tool.execute(part.input);
                } catch (error) {
                  toolOutput = `Error executing tool: ${error instanceof Error ? error.message : String(error)}`;
                }
              }

              await useChatHelpers.addToolResult({
                toolCallId: part.toolCallId,
                tool: toolName,
                output: toolOutput
              });
            }
          }
          useChatHelpers.sendMessage();
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

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  const { addToolResult } = useChatHelpers;

  const addToolResultAndSendMessage: typeof addToolResult = async (...args) => {
    await addToolResult(...args);
    useChatHelpers.sendMessage();
  };

  const clearChatHistory = async () => {
    try {
      await fetch(`${normalizedAgentUrl}/messages`, {
        method: "DELETE",
        credentials,
        headers
      });
      useChatHelpers.setMessages([]);
      setActiveStreams([]);
    } catch (error) {
      console.error("Failed to clear history:", error);
      // Fallback to local clear
      useChatHelpers.setMessages([]);
    }
  };

  return {
    // Core chat functionality from useChat
    ...useChatHelpers,

    // Override with custom implementations
    addToolResult: addToolResultAndSendMessage,

    // HTTP-specific functionality
    clearChatHistory,
    activeStreams,
    resumeStream,
    cancelStream
  } as ReturnType<typeof useChat<ChatMessage>> & {
    clearChatHistory: () => Promise<void>;
    activeStreams: StreamState[];
    resumeStream: (streamId: string) => Promise<void>;
    cancelStream: (streamId: string) => Promise<void>;
  };
}
