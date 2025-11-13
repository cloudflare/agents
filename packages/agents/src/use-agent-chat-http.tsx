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
import { detectToolsRequiringConfirmation, type AITool } from "./ai-react";

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
  _State,
  ChatMessage extends UIMessage = UIMessage
> = Omit<UseChatParams<ChatMessage>, "fetch"> & {
  /** Agent name for HTTP requests */
  agent: string;
  /** Agent instance ID (defaults to "default") */
  id?: string;
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
  /**
   * When true (default), automatically sends the next message only after
   * all pending confirmation-required tool calls have been resolved.
   * @default true
   */
  autoSendAfterAllConfirmationsResolved?: boolean;
};

const requestCache = new Map<string, Promise<Message[]>>();

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
  resumeStream: (streamId: string) => Promise<void>;
  cancelStream: (streamId: string) => Promise<void>;
} {
  const {
    agent,
    id = "default",
    pollingInterval = 2000, // Default 2 second polling
    enableResumableStreams = true,
    getInitialMessages,
    messages: optionsInitialMessages,
    experimental_automaticToolResolution,
    tools,
    toolsRequiringConfirmation: manualToolsRequiringConfirmation,
    autoSendAfterAllConfirmationsResolved = true,
    credentials,
    headers,
    ...rest
  } = options;

  // Auto-detect tools requiring confirmation, or use manual override
  const toolsRequiringConfirmation =
    manualToolsRequiringConfirmation ?? detectToolsRequiringConfirmation(tools);

  const [currentStreamId, setCurrentStreamId] = useState<string | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastPollingTime = useRef<number>(0);
  const chatHelpersRef = useRef<ReturnType<typeof useChat<ChatMessage>> | null>(
    null
  );

  // Construct agent URL from agent name and id
  const normalizedAgentUrl = `/agents/${agent}/${id}`;

  // Storage key for stream persistence
  const storageKey = `agent_stream_${agent}_${id}`;

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
    _request: RequestInfo | URL,
    options: RequestInit = {}
  ) {
    const chatUrl = `${normalizedAgentUrl}/chat`;

    // Parse the request body to check if we should include a stream ID
    let body = {};
    if (options.body) {
      try {
        body = JSON.parse(options.body as string);
      } catch {
        // Not JSON, use as is
      }
    }

    // Include current stream ID if we have one (for reconnection)
    if (currentStreamId && typeof body === "object") {
      body = { ...body, streamId: currentStreamId };
    }

    // Modify the request to use our HTTP endpoint
    const modifiedOptions = {
      ...options,
      body: JSON.stringify(body),
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
        // Store stream ID for persistence
        setCurrentStreamId(streamId);
        if (typeof window !== "undefined") {
          sessionStorage.setItem(storageKey, streamId);
        }
        // Polling will start automatically via useEffect watching currentStreamId
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

  // Keep ref updated
  chatHelpersRef.current = useChatHelpers;

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
          const currentMessages = useChatHelpers.messages;
          if (
            serverMessages.length !== currentMessages.length ||
            (serverMessages.length > 0 &&
              currentMessages.length > 0 &&
              serverMessages[serverMessages.length - 1].id !==
                currentMessages[currentMessages.length - 1].id)
          ) {
            useChatHelpers.setMessages(serverMessages);
          }
        }

        // Check if current stream is still active
        if (enableResumableStreams && currentStreamId) {
          try {
            const statusResponse = await fetch(
              `${normalizedAgentUrl}/stream/${currentStreamId}/status`,
              { credentials, headers }
            );

            if (statusResponse.ok) {
              const status = (await statusResponse.json()) as {
                position: number;
                completed: boolean;
              };

              // Stop polling if stream is completed
              if (status.completed) {
                setCurrentStreamId(null);
                stopPolling();
              }
            }
          } catch (error) {
            console.warn(`Failed to check stream ${currentStreamId}:`, error);
          }
        } else {
          // No active stream, stop polling
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
    currentStreamId,
    stopPolling,
    useChatHelpers
  ]);

  /**
   * Automatically start/stop polling based on active stream
   */
  useEffect(() => {
    if (enableResumableStreams && currentStreamId && pollingInterval > 0) {
      // Start polling when we have an active stream
      startPolling();
    } else {
      // Stop polling when no active stream
      stopPolling();
    }
  }, [
    enableResumableStreams,
    currentStreamId,
    pollingInterval,
    startPolling,
    stopPolling
  ]);

  /**
   * Resume an interrupted stream
   */
  const resumeStream = useCallback(
    async (streamId: string) => {
      try {
        console.log(`Attempting to resume stream ${streamId}`);

        // Simply fetch the stream endpoint to check if it's still active
        const response = await fetch(
          `${normalizedAgentUrl}/stream/${streamId}`,
          {
            credentials,
            headers
          }
        );

        if (response.ok) {
          // Stream exists, just track it
          const isComplete =
            response.headers.get("X-Stream-Complete") === "true";
          if (!isComplete) {
            setCurrentStreamId(streamId);
          }

          // Consume the stream but don't process it here
          // Let the polling mechanism handle message updates
          if (response.body) {
            response.body.cancel();
          }
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
          if (currentStreamId === streamId) {
            setCurrentStreamId(null);
          }
        }
      } catch (error) {
        console.error(`Failed to cancel stream ${streamId}:`, error);
      }
    },
    [normalizedAgentUrl, credentials, headers, currentStreamId]
  );

  const processedToolCalls = useRef(new Set<string>());

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
    toolsRequiringConfirmation,
    tools
  ]);

  // Load persisted stream ID on mount and resume if active
  useEffect(() => {
    if (enableResumableStreams && typeof window !== "undefined") {
      const savedStreamId = sessionStorage.getItem(storageKey);
      if (savedStreamId) {
        console.log(`Found saved stream ID: ${savedStreamId}, reconnecting...`);
        setCurrentStreamId(savedStreamId);

        // replaying the stored chunks
        (async () => {
          try {
            // Reconnect to the stream - server will provide messages in response
            const response = await fetch(`${normalizedAgentUrl}/chat`, {
              method: "POST",
              credentials,
              headers: {
                ...headers,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                messages: [], // Empty - server will use its persisted messages
                streamId: savedStreamId,
                includeMessages: true // Request server to include messages in metadata
              })
            });

            if (response.ok && response.body) {
              console.log(
                `Successfully reconnected to stream ${savedStreamId}`
              );

              // Optionally hydrate messages from header if present
              const messagesHeader = response.headers.get("X-Messages");
              let existingMessages: ChatMessage[] = [];
              if (messagesHeader) {
                try {
                  existingMessages = JSON.parse(
                    decodeURIComponent(messagesHeader)
                  );
                  chatHelpersRef.current?.setMessages(existingMessages);
                } catch (e) {
                  console.warn("Failed to parse messages from header:", e);
                }
              }

              // Initialize assistant message accumulation for resumed stream
              let assistantContent = "";
              const assistantMessageId = `assistant_${Date.now()}`;

              // Process the resumed stream
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffer = "";

              const processStream = async () => {
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                      console.log("Stream completed");
                      // Clear the saved stream ID only if truly complete
                      sessionStorage.removeItem(storageKey);
                      setCurrentStreamId(null);
                      break;
                    }

                    const chunk = decoder.decode(value, { stream: true });
                    buffer += chunk;

                    // Parse SSE events
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                      if (line.trim() === "") continue;
                      if (line.startsWith("data: ")) {
                        const dataStr = line.slice(6);
                        if (dataStr === "[DONE]") {
                          console.log("Stream done marker received");
                          continue;
                        }

                        try {
                          const data = JSON.parse(dataStr);
                          if (data.type === "text-delta" && data.delta) {
                            assistantContent += data.delta;
                            const updatedMessages = [...existingMessages];
                            const lastMessage =
                              updatedMessages[updatedMessages.length - 1];

                            if (
                              lastMessage &&
                              lastMessage.role === "assistant"
                            ) {
                              // const existingParts = lastMessage.parts || [];
                              // Currently not used but kept for potential future use
                              // const textPart = existingParts.find(
                              //   (p) => p.type === "text"
                              // );

                              updatedMessages[updatedMessages.length - 1] = {
                                ...lastMessage,
                                id: assistantMessageId,
                                parts: [
                                  {
                                    type: "text",
                                    text: assistantContent
                                  }
                                ]
                              } as ChatMessage;
                            } else {
                              updatedMessages.push({
                                id: assistantMessageId,
                                role: "assistant",
                                parts: [
                                  {
                                    type: "text",
                                    text: assistantContent
                                  }
                                ]
                              } as unknown as ChatMessage);
                            }

                            chatHelpersRef.current?.setMessages(
                              updatedMessages
                            );
                          }
                        } catch (e) {
                          console.warn("Failed to parse SSE data:", e);
                        }
                      }
                    }
                  }
                } catch (error) {
                  console.error("Stream processing error:", error);
                  // Don't clear stream ID on error
                }
              };

              processStream();
            } else {
              console.log(`Stream ${savedStreamId} not found or completed`);
              sessionStorage.removeItem(storageKey);
              setCurrentStreamId(null);
            }
          } catch (error) {
            console.error("Failed to reconnect to stream:", error);
            sessionStorage.removeItem(storageKey);
            setCurrentStreamId(null);
          }
        })();
      }
    }
    // Only run once on mount
  }, [
    enableResumableStreams,
    storageKey,
    normalizedAgentUrl,
    credentials,
    headers
  ]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  const { addToolResult } = useChatHelpers;

  // Wrapper that sends only when the last pending confirmation is resolved
  const addToolResultAndSendMessage: typeof addToolResult = async (args) => {
    const { toolCallId } = args;

    await addToolResult(args);

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

  const clearChatHistory = async () => {
    try {
      await fetch(`${normalizedAgentUrl}/messages`, {
        method: "DELETE",
        credentials,
        headers
      });
      useChatHelpers.setMessages([]);
      setCurrentStreamId(null);
      if (typeof window !== "undefined") {
        sessionStorage.removeItem(storageKey);
      }
    } catch (error) {
      console.error("Failed to clear history:", error);
      // Fallback to local clear
      useChatHelpers.setMessages([]);
      setCurrentStreamId(null);
      if (typeof window !== "undefined") {
        sessionStorage.removeItem(storageKey);
      }
    }
  };

  return {
    // Core chat functionality from useChat
    ...useChatHelpers,
    // Override with custom implementations
    addToolResult: addToolResultAndSendMessage,
    clearChatHistory,
    resumeStream,
    cancelStream
  } as ReturnType<typeof useChat<ChatMessage>> & {
    clearChatHistory: () => Promise<void>;
    resumeStream: (streamId: string) => Promise<void>;
    cancelStream: (streamId: string) => Promise<void>;
  };
}
