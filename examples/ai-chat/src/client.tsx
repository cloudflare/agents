import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import type { MCPServersState } from "agents";
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
  StopIcon,
  TrashIcon,
  CheckCircleIcon,
  XCircleIcon,
  GearIcon,
  CloudSunIcon,
  PlugsConnectedIcon,
  PlusIcon,
  SignInIcon,
  XIcon,
  WrenchIcon
} from "@phosphor-icons/react";

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
  const [mcpState, setMcpState] = useState<MCPServersState>({
    prompts: [],
    resources: [],
    servers: {},
    tools: []
  });
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [isAddingServer, setIsAddingServer] = useState(false);
  const mcpPanelRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "ChatAgent",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onMcpUpdate: useCallback((state: MCPServersState) => {
      setMcpState(state);
    }, [])
  });

  // Close MCP panel when clicking outside
  useEffect(() => {
    if (!showMcpPanel) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        mcpPanelRef.current &&
        !mcpPanelRef.current.contains(e.target as Node)
      ) {
        setShowMcpPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMcpPanel]);

  const handleAddServer = async () => {
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    setIsAddingServer(true);
    try {
      await agent.call("addServer", [
        mcpName.trim(),
        mcpUrl.trim(),
        window.location.origin
      ]);
      setMcpName("");
      setMcpUrl("");
    } catch (e) {
      console.error("Failed to add MCP server:", e);
    } finally {
      setIsAddingServer(false);
    }
  };

  const handleRemoveServer = async (serverId: string) => {
    try {
      await agent.call("removeServer", [serverId]);
    } catch (e) {
      console.error("Failed to remove MCP server:", e);
    }
  };

  const serverEntries = Object.entries(mcpState.servers);
  const mcpToolCount = mcpState.tools.length;

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status
  } = useAgentChat({
    agent,
    // Custom data sent with every request (available in options.body on server)
    body: {
      clientVersion: "1.0.0"
    },
    // Handle client-side tools (tools without server execute function)
    onToolCall: async ({ toolCall, addToolOutput }) => {
      if (toolCall.toolName === "getUserTimezone") {
        addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            localTime: new Date().toLocaleTimeString()
          }
        });
      }
    }
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
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">AI Chat</h1>
            <Badge variant="secondary">
              <CloudSunIcon size={12} weight="bold" className="mr-1" />
              Tools + Approval
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <div className="relative" ref={mcpPanelRef}>
              <Button
                variant="secondary"
                icon={<PlugsConnectedIcon size={16} />}
                onClick={() => setShowMcpPanel(!showMcpPanel)}
              >
                MCP
                {mcpToolCount > 0 && (
                  <Badge variant="primary" className="ml-1.5">
                    <WrenchIcon size={10} className="mr-0.5" />
                    {mcpToolCount}
                  </Badge>
                )}
              </Button>

              {/* MCP Dropdown Panel */}
              {showMcpPanel && (
                <div className="absolute right-0 top-full mt-2 w-96 z-50">
                  <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-4">
                    {/* Panel Header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <PlugsConnectedIcon
                          size={16}
                          className="text-kumo-accent"
                        />
                        <Text size="sm" bold>
                          MCP Servers
                        </Text>
                        {serverEntries.length > 0 && (
                          <Badge variant="secondary">
                            {serverEntries.length}
                          </Badge>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        aria-label="Close MCP panel"
                        icon={<XIcon size={14} />}
                        onClick={() => setShowMcpPanel(false)}
                      />
                    </div>

                    {/* Add Server Form */}
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleAddServer();
                      }}
                      className="space-y-2"
                    >
                      <input
                        type="text"
                        value={mcpName}
                        onChange={(e) => setMcpName(e.target.value)}
                        placeholder="Server name"
                        className="w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
                      />
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={mcpUrl}
                          onChange={(e) => setMcpUrl(e.target.value)}
                          placeholder="https://mcp.example.com"
                          className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent font-mono"
                        />
                        <Button
                          type="submit"
                          variant="primary"
                          size="sm"
                          icon={<PlusIcon size={14} />}
                          disabled={
                            isAddingServer || !mcpName.trim() || !mcpUrl.trim()
                          }
                        >
                          {isAddingServer ? "..." : "Add"}
                        </Button>
                      </div>
                    </form>

                    {/* Server List */}
                    {serverEntries.length > 0 && (
                      <div className="space-y-2 max-h-60 overflow-y-auto">
                        {serverEntries.map(([id, server]) => (
                          <div
                            key={id}
                            className="flex items-start justify-between p-2.5 rounded-lg border border-kumo-line"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-kumo-default truncate">
                                  {server.name}
                                </span>
                                <Badge
                                  variant={
                                    server.state === "ready"
                                      ? "primary"
                                      : server.state === "failed"
                                        ? "destructive"
                                        : "secondary"
                                  }
                                >
                                  {server.state}
                                </Badge>
                              </div>
                              <span className="text-xs font-mono text-kumo-subtle truncate block mt-0.5">
                                {server.server_url}
                              </span>
                              {server.state === "failed" && server.error && (
                                <span className="text-xs text-red-500 block mt-0.5">
                                  {server.error}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0 ml-2">
                              {server.state === "authenticating" &&
                                server.auth_url && (
                                  <Button
                                    variant="primary"
                                    size="sm"
                                    icon={<SignInIcon size={12} />}
                                    onClick={() =>
                                      window.open(
                                        server.auth_url as string,
                                        "oauth",
                                        "width=600,height=800"
                                      )
                                    }
                                  >
                                    Auth
                                  </Button>
                                )}
                              <Button
                                variant="ghost"
                                size="sm"
                                shape="square"
                                aria-label="Remove server"
                                icon={<TrashIcon size={12} />}
                                onClick={() => handleRemoveServer(id)}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Tool Summary */}
                    {mcpToolCount > 0 && (
                      <div className="pt-2 border-t border-kumo-line">
                        <div className="flex items-center gap-2">
                          <WrenchIcon size={14} className="text-kumo-subtle" />
                          <span className="text-xs text-kumo-subtle">
                            {mcpToolCount} tool
                            {mcpToolCount !== 1 ? "s" : ""} available from MCP
                            servers
                          </span>
                        </div>
                      </div>
                    )}
                  </Surface>
                </div>
              )}
            </div>
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

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<CloudSunIcon size={32} />}
              title="Start a conversation"
              description='Try "What is the weather in London?" or "What timezone am I in?" or "What is 5000 + 3000?"'
            />
          )}

          {messages.map((message, index) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;

            if (isUser) {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                    {getMessageText(message)}
                  </div>
                </div>
              );
            }

            // Assistant: render parts in order
            return (
              <div key={message.id} className="space-y-2">
                {message.parts.map((part, partIndex) => {
                  // Text
                  if (part.type === "text") {
                    if (!part.text) return null;
                    const isLastTextPart = message.parts
                      .slice(partIndex + 1)
                      .every((p) => p.type !== "text");
                    return (
                      <div key={partIndex} className="flex justify-start">
                        <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                          <div className="whitespace-pre-wrap">
                            {part.text}
                            {isLastAssistant &&
                              isLastTextPart &&
                              isStreaming && (
                                <span className="inline-block w-0.5 h-[1em] bg-kumo-brand ml-0.5 align-text-bottom animate-blink-cursor" />
                              )}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  // Reasoning
                  if (part.type === "reasoning") {
                    if (!part.text) return null;
                    return (
                      <div key={partIndex} className="flex justify-start">
                        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line opacity-70">
                          <div className="flex items-center gap-2 mb-1">
                            <GearIcon
                              size={14}
                              className="text-kumo-inactive"
                            />
                            <Text size="xs" variant="secondary" bold>
                              Thinking
                            </Text>
                          </div>
                          <div className="whitespace-pre-wrap text-xs text-kumo-subtle italic">
                            {part.text}
                          </div>
                        </Surface>
                      </div>
                    );
                  }

                  // Tool invocations
                  if (!isToolUIPart(part)) return null;
                  const toolName = getToolName(part);

                  // Tool completed
                  if (part.state === "output-available") {
                    return (
                      <div key={part.toolCallId} className="flex justify-start">
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

                  // Tool needs approval
                  if (
                    "approval" in part &&
                    part.state === "approval-requested"
                  ) {
                    const approvalId = (part.approval as { id?: string })?.id;
                    return (
                      <div key={part.toolCallId} className="flex justify-start">
                        <Surface className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning">
                          <div className="flex items-center gap-2 mb-2">
                            <GearIcon size={14} className="text-kumo-warning" />
                            <Text size="sm" bold>
                              Approval needed: {toolName}
                            </Text>
                          </div>
                          <div className="font-mono mb-3">
                            <Text size="xs" variant="secondary">
                              {JSON.stringify(part.input, null, 2)}
                            </Text>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="primary"
                              size="sm"
                              icon={<CheckCircleIcon size={14} />}
                              onClick={() => {
                                if (approvalId) {
                                  addToolApprovalResponse({
                                    id: approvalId,
                                    approved: true
                                  });
                                }
                              }}
                            >
                              Approve
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<XCircleIcon size={14} />}
                              onClick={() => {
                                if (approvalId) {
                                  addToolApprovalResponse({
                                    id: approvalId,
                                    approved: false
                                  });
                                }
                              }}
                            >
                              Reject
                            </Button>
                          </div>
                        </Surface>
                      </div>
                    );
                  }

                  // Tool denied
                  if (part.state === "output-denied") {
                    return (
                      <div key={part.toolCallId} className="flex justify-start">
                        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                          <div className="flex items-center gap-2">
                            <XCircleIcon
                              size={14}
                              className="text-kumo-inactive"
                            />
                            <Text size="xs" variant="secondary" bold>
                              {toolName}
                            </Text>
                            <Badge variant="secondary">Denied</Badge>
                          </div>
                        </Surface>
                      </div>
                    );
                  }

                  // Tool executing
                  if (
                    part.state === "input-available" ||
                    part.state === "input-streaming"
                  ) {
                    return (
                      <div key={part.toolCallId} className="flex justify-start">
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
              placeholder="Try: What's the weather in Paris?"
              disabled={!isConnected || isStreaming}
              rows={2}
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop streaming"
                onClick={stop}
                icon={<StopIcon size={18} weight="fill" />}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={!input.trim() || !isConnected}
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            )}
          </div>
        </form>
        <div className="flex justify-center pb-3">
          <PoweredByAgents />
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
