import {
  Suspense,
  useCallback,
  useState,
  useEffect,
  useRef,
  useMemo
} from "react";
import { useAgent } from "agents/react";
import {
  useAgentChat,
  type AITool,
  type OnToolCallCallback
} from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import {
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents,
  type ConnectionStatus
} from "@cloudflare/agents-ui";
import {
  PaperPlaneRightIcon,
  TrashIcon,
  GearIcon,
  PlugIcon,
  InfoIcon,
  ToggleLeftIcon,
  ToggleRightIcon
} from "@phosphor-icons/react";

/**
 * Available tools that a "third-party developer" could register.
 * In a real SDK, these would be passed as props to a chat widget.
 */
const AVAILABLE_TOOLS: Record<
  string,
  { tool: AITool; label: string; description: string }
> = {
  getPageTitle: {
    label: "getPageTitle",
    description: "Returns the current page title from the browser",
    tool: {
      description: "Get the current page title from the user's browser",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => ({ title: document.title })
    }
  },
  getCurrentTime: {
    label: "getCurrentTime",
    description: "Returns the user's local time and timezone",
    tool: {
      description: "Get the user's current local time and timezone",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => ({
        time: new Date().toLocaleTimeString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      })
    }
  },
  getScreenInfo: {
    label: "getScreenInfo",
    description: "Returns screen dimensions and pixel ratio",
    tool: {
      description: "Get the user's screen dimensions and device pixel ratio",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => ({
        width: window.innerWidth,
        height: window.innerHeight,
        pixelRatio: window.devicePixelRatio
      })
    }
  },
  getColorScheme: {
    label: "getColorScheme",
    description: "Returns the user's preferred color scheme",
    tool: {
      description: "Get whether the user prefers light or dark mode",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => ({
        scheme: window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light",
        current: document.documentElement.getAttribute("data-mode") || "unknown"
      })
    }
  }
};

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

function Chat() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Track which tools are enabled — simulates an SDK user toggling tools
  const [enabledTools, setEnabledTools] = useState<Set<string>>(
    new Set(Object.keys(AVAILABLE_TOOLS))
  );

  const toggleTool = useCallback((name: string) => {
    setEnabledTools((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  // Build the active tools record from enabled set
  const activeTools = useMemo(() => {
    const tools: Record<string, AITool> = {};
    for (const name of enabledTools) {
      const entry = AVAILABLE_TOOLS[name];
      if (entry) {
        tools[name] = entry.tool;
      }
    }
    return Object.keys(tools).length > 0 ? tools : undefined;
  }, [enabledTools]);

  const agent = useAgent({
    agent: "DynamicToolsAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent,
    // Dynamic tools — schemas are sent to the server automatically
    tools: activeTools,
    // Execute tool calls routed back from the server
    onToolCall: useCallback<OnToolCallCallback>(
      async ({ toolCall, addToolOutput }) => {
        const tool = activeTools?.[toolCall.toolName];
        if (tool?.execute) {
          const output = await tool.execute(toolCall.input);
          addToolOutput({ toolCallId: toolCall.toolCallId, output });
        }
      },
      [activeTools]
    )
  });

  const isStreaming = status === "streaming";
  const isConnected = connectionStatus === "connected";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Dynamic Tools
            </h1>
            <Badge variant="secondary">
              <PlugIcon size={12} weight="bold" className="mr-1" />
              SDK Pattern
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Tool sidebar */}
        <aside className="w-72 border-r border-kumo-line bg-kumo-base overflow-y-auto p-4 space-y-4 shrink-0">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  Dynamic Tool Registration
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    Toggle tools on/off to simulate an SDK where third-party
                    developers register tools at runtime. The server accepts
                    whatever tools the client sends.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          <div>
            <span className="mb-2 block">
              <Text size="sm" bold>
                Available Tools
              </Text>
            </span>
            <div className="space-y-2">
              {Object.entries(AVAILABLE_TOOLS).map(([name, entry]) => {
                const enabled = enabledTools.has(name);
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggleTool(name)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors cursor-pointer ${
                      enabled
                        ? "border-kumo-accent bg-kumo-accent/5"
                        : "border-kumo-line bg-kumo-base opacity-60"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="flex items-center gap-1.5">
                        <Text size="xs" bold>
                          {entry.label}
                        </Text>
                      </span>
                      {enabled ? (
                        <ToggleRightIcon
                          size={20}
                          weight="fill"
                          className="text-kumo-accent"
                        />
                      ) : (
                        <ToggleLeftIcon
                          size={20}
                          className="text-kumo-inactive"
                        />
                      )}
                    </div>
                    <Text size="xs" variant="secondary">
                      {entry.description}
                    </Text>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="pt-2 border-t border-kumo-line">
            <Text size="xs" variant="secondary">
              {enabledTools.size} of {Object.keys(AVAILABLE_TOOLS).length} tools
              active
            </Text>
          </div>
        </aside>

        {/* Chat area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
              {messages.length === 0 && (
                <Empty
                  icon={<PlugIcon size={32} />}
                  title="Dynamic tools are ready"
                  description='Toggle tools in the sidebar, then ask something like "What page am I on?", "What time is it?", or "What is my screen size?"'
                />
              )}

              {messages.map((message, index) => {
                const isUser = message.role === "user";
                const isLastAssistant =
                  message.role === "assistant" && index === messages.length - 1;

                return (
                  <div key={message.id} className="space-y-2">
                    {isUser ? (
                      <div className="flex justify-end">
                        <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                          {getMessageText(message)}
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-start">
                        <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                          <div className="whitespace-pre-wrap">
                            {getMessageText(message)}
                            {isLastAssistant && isStreaming && (
                              <span className="inline-block w-0.5 h-[1em] bg-kumo-brand ml-0.5 align-text-bottom animate-blink-cursor" />
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Tool parts */}
                    {message.parts
                      .filter((part) => isToolUIPart(part))
                      .map((part) => {
                        if (!isToolUIPart(part)) return null;
                        const toolName = getToolName(part);

                        if (part.state === "output-available") {
                          return (
                            <div
                              key={part.toolCallId}
                              className="flex justify-start"
                            >
                              <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                                <div className="flex items-center gap-2 mb-1">
                                  <GearIcon
                                    size={14}
                                    className="text-kumo-inactive"
                                  />
                                  <Text size="xs" variant="secondary" bold>
                                    {toolName}
                                  </Text>
                                  <Badge variant="secondary">Done</Badge>
                                </div>
                                <div className="font-mono">
                                  <Text size="xs" variant="secondary">
                                    {JSON.stringify(part.output, null, 2)}
                                  </Text>
                                </div>
                              </Surface>
                            </div>
                          );
                        }

                        if (
                          part.state === "input-available" ||
                          part.state === "input-streaming"
                        ) {
                          return (
                            <div
                              key={part.toolCallId}
                              className="flex justify-start"
                            >
                              <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                                <div className="flex items-center gap-2">
                                  <GearIcon
                                    size={14}
                                    className="text-kumo-inactive animate-spin"
                                  />
                                  <Text size="xs" variant="secondary">
                                    Running {toolName}...
                                  </Text>
                                </div>
                              </Surface>
                            </div>
                          );
                        }

                        return null;
                      })}
                  </div>
                );
              })}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input */}
          <div className="border-t border-kumo-line bg-kumo-base">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
              className="max-w-3xl mx-auto px-5 py-4"
            >
              <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
                <InputArea
                  value={input}
                  onValueChange={setInput}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={
                    enabledTools.size > 0
                      ? 'Try "What page am I on?" or "What time is it?"'
                      : "No tools enabled — toggle some in the sidebar"
                  }
                  disabled={!isConnected || isStreaming}
                  rows={2}
                  className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
                />
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  aria-label="Send message"
                  disabled={!input.trim() || !isConnected || isStreaming}
                  icon={<PaperPlaneRightIcon size={18} />}
                  loading={isStreaming}
                  className="mb-0.5"
                />
              </div>
            </form>
            <div className="flex justify-center pb-3">
              <PoweredByAgents />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}
