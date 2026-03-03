import "./styles.css";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@cloudflare/agents-ui/hooks";
import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, isReasoningUIPart, getToolName } from "ai";
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
  StopIcon,
  TrashIcon,
  GearIcon,
  InfoIcon,
  FolderIcon,
  PlusIcon,
  ChatTextIcon,
  SidebarIcon,
  PencilSimpleIcon,
  PuzzlePieceIcon,
  BrainIcon,
  CaretDownIcon,
  XIcon
} from "@phosphor-icons/react";

type SessionInfo = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

type ExtensionInfo = {
  name: string;
  version: string;
  description?: string;
  tools: string[];
  permissions: {
    network?: string[];
    workspace?: "read" | "read-write" | "none";
  };
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);

  const agent = useAgent({
    agent: "MyAssistant",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming";
  const isConnected = connectionStatus === "connected";

  const refreshExtensions = useCallback(async () => {
    const result = await agent.call("listExtensions", []);
    setExtensions(result as ExtensionInfo[]);
  }, [agent]);

  const handleUnloadExtension = useCallback(
    async (name: string) => {
      await agent.call("unloadExtension", [name]);
      await refreshExtensions();
    },
    [agent, refreshExtensions]
  );

  // Load sessions and extensions on connect
  useEffect(() => {
    if (!isConnected) return;
    agent.call("getSessions", []).then((result: unknown) => {
      setSessions(result as SessionInfo[]);
    });
    agent.call("getCurrentSessionId", []).then((result: unknown) => {
      setCurrentSessionId(result as string | null);
    });
    refreshExtensions();
  }, [isConnected, agent, refreshExtensions]);

  const refreshSessions = useCallback(async () => {
    const result = await agent.call("getSessions", []);
    setSessions(result as SessionInfo[]);
  }, [agent]);

  const handleCreateSession = useCallback(async () => {
    const result = await agent.call("createSession", ["New Chat"]);
    const session = result as SessionInfo;
    setCurrentSessionId(session.id);
    clearHistory();
    await refreshSessions();
  }, [agent, clearHistory, refreshSessions]);

  const handleSwitchSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === currentSessionId) return;
      await agent.call("switchSession", [sessionId]);
      setCurrentSessionId(sessionId);
      // Reload to pick up new session's messages
      window.location.reload();
    },
    [agent, currentSessionId]
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      await agent.call("deleteSession", [sessionId]);
      if (sessionId === currentSessionId) {
        setCurrentSessionId(null);
        clearHistory();
      }
      await refreshSessions();
    },
    [agent, currentSessionId, clearHistory, refreshSessions]
  );

  const handleRenameSession = useCallback(
    async (sessionId: string, name: string) => {
      await agent.call("renameSession", [sessionId, name]);
      setEditingSessionId(null);
      await refreshSessions();
    },
    [agent, refreshSessions]
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  // Refresh extensions when streaming finishes (extensions may have been loaded)
  useEffect(() => {
    if (status === "ready" && isConnected) {
      refreshExtensions();
    }
  }, [status, isConnected, refreshExtensions]);

  const currentSession = sessions.find((s) => s.id === currentSessionId);

  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* Sidebar */}
      {sidebarOpen && (
        <aside className="w-64 shrink-0 border-r border-kumo-line bg-kumo-base flex flex-col">
          <div className="p-3 border-b border-kumo-line flex items-center justify-between">
            <span className="text-sm font-semibold text-kumo-default">
              Sessions
            </span>
            <Button
              variant="secondary"
              shape="square"
              aria-label="New session"
              icon={<PlusIcon size={16} />}
              onClick={handleCreateSession}
              disabled={!isConnected}
            />
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {sessions.length === 0 && (
              <div className="px-3 py-6 text-center">
                <Text size="xs" variant="secondary">
                  No sessions yet
                </Text>
              </div>
            )}
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors w-full text-left ${
                  session.id === currentSessionId
                    ? "bg-kumo-elevated ring-1 ring-kumo-line"
                    : "hover:bg-kumo-elevated/50"
                }`}
                onClick={() => handleSwitchSession(session.id)}
              >
                <ChatTextIcon
                  size={14}
                  className="shrink-0 text-kumo-inactive"
                />
                {editingSessionId === session.id ? (
                  <input
                    className="flex-1 text-xs bg-transparent border-b border-kumo-line text-kumo-default outline-none"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleRenameSession(session.id, editName);
                      }
                      if (e.key === "Escape") {
                        setEditingSessionId(null);
                      }
                    }}
                    onBlur={() => handleRenameSession(session.id, editName)}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="flex-1 text-xs text-kumo-default truncate">
                    {session.name}
                  </span>
                )}
                <div className="hidden group-hover:flex items-center gap-0.5">
                  <button
                    className="p-0.5 rounded hover:bg-kumo-line text-kumo-inactive hover:text-kumo-default transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingSessionId(session.id);
                      setEditName(session.name);
                    }}
                    aria-label="Rename session"
                  >
                    <PencilSimpleIcon size={12} />
                  </button>
                  <button
                    className="p-0.5 rounded hover:bg-kumo-line text-kumo-inactive hover:text-kumo-default transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteSession(session.id);
                    }}
                    aria-label="Delete session"
                  >
                    <XIcon size={12} />
                  </button>
                </div>
              </button>
            ))}
          </div>

          {/* Extensions panel */}
          <div className="border-t border-kumo-line">
            <div className="p-3 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <PuzzlePieceIcon size={14} className="text-kumo-inactive" />
                <span className="text-xs font-semibold text-kumo-default">
                  Extensions
                </span>
              </div>
              {extensions.length > 0 && (
                <Badge variant="secondary">{extensions.length}</Badge>
              )}
            </div>
            <div className="px-2 pb-3 space-y-1">
              {extensions.length === 0 ? (
                <div className="px-3 py-2 text-center">
                  <Text size="xs" variant="secondary">
                    No extensions loaded
                  </Text>
                </div>
              ) : (
                extensions.map((ext) => (
                  <div
                    key={ext.name}
                    className="group/ext px-3 py-2 rounded-lg bg-kumo-elevated/50"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-kumo-default flex-1">
                        {ext.name}
                      </span>
                      <span className="text-[10px] text-kumo-inactive">
                        v{ext.version}
                      </span>
                      <button
                        className="hidden group-hover/ext:block p-0.5 rounded hover:bg-kumo-line text-kumo-inactive hover:text-kumo-default transition-colors"
                        onClick={() => handleUnloadExtension(ext.name)}
                        aria-label={`Unload ${ext.name}`}
                      >
                        <XIcon size={12} />
                      </button>
                    </div>
                    {ext.description && (
                      <span className="block mt-0.5">
                        <Text size="xs" variant="secondary">
                          {ext.description}
                        </Text>
                      </span>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {ext.tools.map((tool) => (
                        <Badge key={tool} variant="secondary">
                          {tool}
                        </Badge>
                      ))}
                    </div>
                    {(ext.permissions.workspace &&
                      ext.permissions.workspace !== "none") ||
                    (ext.permissions.network &&
                      ext.permissions.network.length > 0) ? (
                      <div className="mt-1.5 flex gap-1">
                        {ext.permissions.workspace &&
                          ext.permissions.workspace !== "none" && (
                            <Badge variant="secondary">
                              <FolderIcon size={10} className="mr-0.5" />
                              {ext.permissions.workspace}
                            </Badge>
                          )}
                        {ext.permissions.network &&
                          ext.permissions.network.length > 0 && (
                            <Badge variant="secondary">
                              net: {ext.permissions.network.join(", ")}
                            </Badge>
                          )}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button
                variant="secondary"
                shape="square"
                aria-label="Toggle sidebar"
                icon={<SidebarIcon size={16} />}
                onClick={() => setSidebarOpen(!sidebarOpen)}
              />
              <h1 className="text-lg font-semibold text-kumo-default">
                {currentSession?.name || "Assistant"}
              </h1>
              <Badge variant="secondary">
                <FolderIcon size={12} weight="bold" className="mr-1" />
                Workspace Tools
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

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
            {/* Explainer */}
            {messages.length === 0 && (
              <>
                <Surface className="p-4 rounded-xl ring ring-kumo-line">
                  <div className="flex gap-3">
                    <InfoIcon
                      size={20}
                      weight="bold"
                      className="text-kumo-accent shrink-0 mt-0.5"
                    />
                    <div>
                      <Text size="sm" bold>
                        Workspace Assistant
                      </Text>
                      <span className="mt-1 block">
                        <Text size="xs" variant="secondary">
                          A coding assistant with a persistent virtual
                          filesystem. It can read, write, edit, find, and search
                          files. Ask it to create a project, write code, or
                          manage files.
                        </Text>
                      </span>
                    </div>
                  </div>
                </Surface>
                <Empty
                  icon={<FolderIcon size={32} />}
                  title="Start a conversation"
                  description='Try "Create a simple HTML page" or "Write a package.json for a Node.js project"'
                />
              </>
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

              return (
                <div key={message.id} className="space-y-2">
                  {message.parts.map((part, partIndex) => {
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

                    if (isReasoningUIPart(part)) {
                      if (!part.text) return null;
                      const isStreamingReasoning =
                        isLastAssistant &&
                        isStreaming &&
                        part.state === "streaming";
                      return (
                        <div key={partIndex} className="flex justify-start">
                          <details
                            className="max-w-[85%] group"
                            open={isStreamingReasoning}
                          >
                            <summary className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-kumo-elevated/50 cursor-pointer select-none list-none">
                              <BrainIcon
                                size={14}
                                className={`text-kumo-inactive shrink-0 ${
                                  isStreamingReasoning ? "animate-pulse" : ""
                                }`}
                              />
                              <span className="text-xs text-kumo-inactive">
                                Reasoning
                              </span>
                              <CaretDownIcon
                                size={12}
                                className="text-kumo-inactive transition-transform group-open:rotate-180"
                              />
                            </summary>
                            <div className="mt-1 px-3 py-2 rounded-lg bg-kumo-elevated/30 border border-kumo-line/50">
                              <div className="whitespace-pre-wrap text-xs text-kumo-secondary leading-relaxed italic">
                                {part.text}
                                {isStreamingReasoning && (
                                  <span className="inline-block w-0.5 h-[1em] bg-kumo-inactive ml-0.5 align-text-bottom animate-blink-cursor" />
                                )}
                              </div>
                            </div>
                          </details>
                        </div>
                      );
                    }

                    if (!isToolUIPart(part)) return null;
                    const toolName = getToolName(part);

                    // Tool completed
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
                            <div className="font-mono max-h-48 overflow-y-auto">
                              <Text size="xs" variant="secondary">
                                {formatToolOutput(part.output)}
                              </Text>
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
                placeholder="Ask me to create files, write code, or manage your workspace..."
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
    </div>
  );
}

function formatToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function App() {
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

const root = document.getElementById("root")!;
createRoot(root).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
