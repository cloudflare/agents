/**
 * Assistant — Client
 *
 * Left sidebar: session list with create/delete/clear/rename.
 * Main area: chat for the active session.
 *
 * Data sources:
 *   - Session list: from Agent state sync (useAgent onStateUpdate)
 *   - Chat messages & streaming: useChat with custom AgentChatTransport
 *   - Session CRUD: via agent.call() RPC
 *
 * The AgentChatTransport bridges the AI SDK's useChat hook with the Agent
 * WebSocket connection: sendMessages() triggers the server-side RPC, then
 * pipes WS stream-event messages into a ReadableStream<UIMessageChunk>
 * that useChat consumes and renders.
 */

import "./styles.css";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@cloudflare/agents-ui/hooks";
import {
  Suspense,
  useCallback,
  useState,
  useEffect,
  useRef,
  useMemo
} from "react";
import { useAgent } from "agents/react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage, UIMessageChunk, ChatTransport } from "ai";
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
  PlusIcon,
  ChatTextIcon,
  BroomIcon,
  InfoIcon,
  FolderIcon,
  GearIcon,
  PlugsConnectedIcon,
  WrenchIcon,
  SignInIcon,
  TrashIcon,
  XIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import type { AppState, SessionInfo } from "./server";

// ─── Helpers ──────────────────────────────────────────────────────────────

function getMessageText(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

// ─── Custom Transport ─────────────────────────────────────────────────────

interface AgentSocket {
  addEventListener(
    type: "message",
    handler: (event: MessageEvent) => void,
    options?: { signal?: AbortSignal }
  ): void;
  removeEventListener(
    type: "message",
    handler: (event: MessageEvent) => void
  ): void;
  call(method: string, args?: unknown[]): Promise<unknown>;
  send(data: string): void;
}

/**
 * Bridges useChat with the Agent WebSocket connection.
 *
 * Features:
 * - Request ID correlation: each request gets a unique ID, only matching
 *   WS messages are processed
 * - Cancel: sends { type: "cancel", requestId } to stop server-side streaming
 * - Completion guard: close/error/abort are idempotent
 * - Signal-based cleanup: uses AbortController signal on addEventListener
 * - Stream resumption: reconnectToStream sends resume-request, server replays
 *   buffered chunks
 */
class AgentChatTransport implements ChatTransport<UIMessage> {
  #agent: AgentSocket;
  #activeRequestIds = new Set<string>();
  #currentFinish: (() => void) | null = null;

  constructor(agent: AgentSocket) {
    this.#agent = agent;
  }

  detach() {
    this.#currentFinish?.();
    this.#currentFinish = null;
  }

  async sendMessages({
    messages,
    abortSignal
  }: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const lastMessage = messages[messages.length - 1];
    const text = getMessageText(lastMessage);
    const requestId = crypto.randomUUID().slice(0, 8);

    let completed = false;
    const abortController = new AbortController();
    let streamController!: ReadableStreamDefaultController<UIMessageChunk>;

    const finish = (action: () => void) => {
      if (completed) return;
      completed = true;
      this.#currentFinish = null;
      try {
        action();
      } catch {
        /* stream may already be closed */
      }
      this.#activeRequestIds.delete(requestId);
      abortController.abort();
    };

    this.#currentFinish = () => finish(() => streamController.close());

    const onAbort = () => {
      if (completed) return;
      try {
        this.#agent.send(JSON.stringify({ type: "cancel", requestId }));
      } catch {
        /* ignore send failures */
      }
      finish(() =>
        streamController.error(
          Object.assign(new Error("Aborted"), { name: "AbortError" })
        )
      );
    };

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        onAbort();
      }
    });

    this.#agent.addEventListener(
      "message",
      (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.requestId !== requestId) return;
          if (msg.type === "stream-event") {
            const chunk: UIMessageChunk = JSON.parse(msg.event);
            streamController.enqueue(chunk);
          } else if (msg.type === "stream-done") {
            finish(() => streamController.close());
          }
        } catch {
          /* ignore parse errors */
        }
      },
      { signal: abortController.signal }
    );

    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
      if (abortSignal.aborted) onAbort();
    }

    this.#activeRequestIds.add(requestId);

    this.#agent.call("sendMessage", [text, requestId]).catch((error: Error) => {
      finish(() => streamController.error(error));
    });

    return stream;
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return new Promise<ReadableStream<UIMessageChunk> | null>((resolve) => {
      let resolved = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const done = (value: ReadableStream<UIMessageChunk> | null) => {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        this.#agent.removeEventListener("message", handler);
        resolve(value);
      };

      const handler = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "stream-resuming") {
            done(this.#createResumeStream(msg.requestId));
          }
        } catch {
          /* ignore */
        }
      };

      this.#agent.addEventListener("message", handler);

      try {
        this.#agent.send(JSON.stringify({ type: "resume-request" }));
      } catch {
        /* WebSocket may not be open yet */
      }

      timeout = setTimeout(() => done(null), 500);
    });
  }

  #createResumeStream(requestId: string): ReadableStream<UIMessageChunk> {
    const abortController = new AbortController();
    let completed = false;

    const finish = (action: () => void) => {
      if (completed) return;
      completed = true;
      try {
        action();
      } catch {
        /* stream may already be closed */
      }
      this.#activeRequestIds.delete(requestId);
      abortController.abort();
    };

    this.#activeRequestIds.add(requestId);

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        this.#agent.addEventListener(
          "message",
          (event: MessageEvent) => {
            if (typeof event.data !== "string") return;
            try {
              const msg = JSON.parse(event.data);
              if (msg.requestId !== requestId) return;
              if (msg.type === "stream-event") {
                const chunk: UIMessageChunk = JSON.parse(msg.event);
                controller.enqueue(chunk);
              } else if (msg.type === "stream-done") {
                finish(() => controller.close());
              }
            } catch {
              /* ignore */
            }
          },
          { signal: abortController.signal }
        );
      },
      cancel() {
        finish(() => {});
      }
    });
  }
}

// ─── Session Sidebar ──────────────────────────────────────────────────────

function SessionSidebar({
  sessions,
  activeSessionId,
  onSwitch,
  onCreate,
  onDelete,
  onClear,
  onRename
}: {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onClear: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-kumo-line flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ChatTextIcon size={18} className="text-kumo-brand" />
          <Text size="sm" bold>
            Sessions
          </Text>
          <Badge variant="secondary">{sessions.length}</Badge>
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<PlusIcon size={14} />}
          onClick={onCreate}
        >
          New
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {sessions.length === 0 && (
          <div className="px-2 py-8 text-center">
            <Text size="xs" variant="secondary">
              No sessions yet. Create one to start chatting.
            </Text>
          </div>
        )}

        {sessions.map((session) => {
          const isActive = session.id === activeSessionId;
          return (
            <div
              key={session.id}
              // oxlint-disable-next-line prefer-tag-over-role
              role="button"
              tabIndex={0}
              className={`group rounded-lg px-3 py-2 cursor-pointer transition-colors w-full text-left ${
                isActive
                  ? "bg-kumo-tint ring-1 ring-kumo-ring"
                  : "hover:bg-kumo-tint/50"
              }`}
              onClick={() => onSwitch(session.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSwitch(session.id);
                }
              }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <ChatTextIcon
                    size={14}
                    className={
                      isActive ? "text-kumo-brand" : "text-kumo-inactive"
                    }
                  />
                  {editingId === session.id ? (
                    <input
                      className="flex-1 text-sm bg-transparent border-b border-kumo-line text-kumo-default outline-none"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          onRename(session.id, editName);
                          setEditingId(null);
                        }
                        if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      onBlur={() => {
                        onRename(session.id, editName);
                        setEditingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <Text size="sm" bold>
                      {session.name}
                    </Text>
                  )}
                </div>
                {session.messageCount > 0 && editingId !== session.id && (
                  <Badge variant="secondary">{session.messageCount}</Badge>
                )}
              </div>

              <div
                className={`flex items-center gap-1 mt-1.5 ${
                  isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                } transition-opacity`}
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingId(session.id);
                    setEditName(session.name);
                  }}
                >
                  Rename
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClear(session.id);
                  }}
                >
                  Clear
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(session.id);
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Messages ──────────────────────────────────────────────────────────────

function Messages({
  messages,
  status
}: {
  messages: UIMessage[];
  status: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const isBusy = status === "submitted" || status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isBusy]);

  if (messages.length === 0 && !isBusy) {
    return (
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
                  A coding assistant with a persistent virtual filesystem
                  (session + shared workspace), workspace tools, and optional
                  MCP server connections. Ask it to create a project, write
                  code, or manage files.
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
    );
  }

  return (
    <div className="space-y-4">
      {messages.map((msg) => (
        <div key={msg.id}>
          {msg.role === "user" ? (
            <div className="flex justify-end">
              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                {getMessageText(msg)}
              </div>
            </div>
          ) : (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed overflow-hidden">
                {msg.parts.map((part, i) => {
                  if (part.type === "reasoning") {
                    return (
                      <details
                        key={i}
                        className="px-4 py-2 border-b border-kumo-line"
                        open={"state" in part && part.state === "streaming"}
                      >
                        <summary className="cursor-pointer text-xs text-kumo-inactive select-none">
                          Reasoning
                        </summary>
                        <div className="mt-1 text-xs text-kumo-secondary italic whitespace-pre-wrap">
                          {part.text}
                        </div>
                      </details>
                    );
                  }
                  if ("toolName" in part && "toolCallId" in part) {
                    const tp = part as unknown as {
                      toolName: string;
                      toolCallId: string;
                      state: string;
                      input: unknown;
                      output?: unknown;
                    };
                    return (
                      <div
                        key={i}
                        className="px-4 py-2.5 border-b border-kumo-line"
                      >
                        <div className="flex items-center gap-2">
                          <GearIcon
                            size={14}
                            className={
                              tp.state === "output-available"
                                ? "text-kumo-inactive"
                                : "text-kumo-inactive animate-spin"
                            }
                          />
                          <Text size="xs" bold>
                            {tp.toolName}
                          </Text>
                          <Badge variant="secondary">{tp.state}</Badge>
                        </div>
                        {tp.input != null &&
                          Object.keys(tp.input as Record<string, unknown>)
                            .length > 0 && (
                            <pre className="mt-1 text-xs text-kumo-secondary overflow-auto">
                              {JSON.stringify(tp.input, null, 2)}
                            </pre>
                          )}
                        {tp.state === "output-available" &&
                          tp.output != null && (
                            <pre className="mt-1 text-xs text-kumo-brand overflow-auto">
                              {formatToolOutput(tp.output)}
                            </pre>
                          )}
                      </div>
                    );
                  }
                  if (part.type === "text") {
                    return (
                      <Streamdown
                        key={i}
                        className="sd-theme px-4 py-2.5"
                        controls={false}
                        isAnimating={
                          "state" in part && part.state === "streaming"
                        }
                      >
                        {part.text}
                      </Streamdown>
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          )}
        </div>
      ))}

      {status === "submitted" && (
        <div className="flex justify-start">
          <div className="px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-kumo-brand rounded-full animate-pulse" />
              <Text size="xs" variant="secondary">
                Thinking...
              </Text>
            </div>
          </div>
        </div>
      )}

      <div ref={endRef} />
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

// ─── Main ──────────────────────────────────────────────────────────────────

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
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

  const setChatMessagesRef = useRef<((messages: UIMessage[]) => void) | null>(
    null
  );

  const handleServerMessage = useCallback((event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "messages") {
        setActiveSessionId(msg.sessionId);
        setChatMessagesRef.current?.(msg.messages);
      }
    } catch {
      /* ignore parse errors */
    }
  }, []);

  const agent = useAgent<AppState>({
    agent: "MyAssistant",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onStateUpdate: useCallback(
      (state: AppState) => setSessions(state.sessions),
      []
    ),
    onMessage: handleServerMessage,
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

  const handleAddServer = useCallback(async () => {
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
  }, [agent, mcpName, mcpUrl]);

  const handleRemoveServer = useCallback(
    async (serverId: string) => {
      try {
        await agent.call("removeServer", [serverId]);
      } catch (e) {
        console.error("Failed to remove MCP server:", e);
      }
    },
    [agent]
  );

  const serverEntries = Object.entries(mcpState.servers);
  const mcpToolCount = mcpState.tools.length;

  const transport = useMemo(() => new AgentChatTransport(agent), [agent]);

  const {
    messages,
    setMessages: setChatMessages,
    sendMessage,
    resumeStream,
    status
  } = useChat({ transport });

  setChatMessagesRef.current = setChatMessages;

  const isConnected = connectionStatus === "connected";
  const isBusy = status === "submitted" || status === "streaming";

  const handleCreate = useCallback(async () => {
    const name = `Chat ${(sessions.length ?? 0) + 1}`;
    await agent.call("createSession", [name]);
  }, [agent, sessions]);

  const handleDelete = useCallback(
    async (id: string) => {
      transport.detach();
      await agent.call("deleteSession", [id]);
      if (activeSessionId === id) {
        setActiveSessionId(null);
        setChatMessages([]);
      }
    },
    [agent, activeSessionId, setChatMessages, transport]
  );

  const handleClear = useCallback(
    async (id: string) => agent.call("clearSession", [id]),
    [agent]
  );

  const handleRename = useCallback(
    async (id: string, name: string) => agent.call("renameSession", [id, name]),
    [agent]
  );

  const handleSwitch = useCallback(
    async (id: string) => {
      transport.detach();
      await agent.call("switchSession", [id]);
      resumeStream();
    },
    [agent, transport, resumeStream]
  );

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isBusy || !activeSessionId) return;
    setInput("");
    sendMessage({ text });
  }, [input, isBusy, activeSessionId, sendMessage]);

  const activeSession = sessions.find((r) => r.id === activeSessionId);

  return (
    <div className="flex h-screen bg-kumo-elevated">
      {/* Left: Session sidebar */}
      <div className="w-[260px] bg-kumo-base border-r border-kumo-line shrink-0">
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSwitch={handleSwitch}
          onCreate={handleCreate}
          onDelete={handleDelete}
          onClear={handleClear}
          onRename={handleRename}
        />
      </div>

      {/* Main: Chat */}
      <div className="flex flex-col flex-1 min-w-0">
        <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {activeSession ? (
                <>
                  <ChatTextIcon size={20} className="text-kumo-brand" />
                  <Text size="lg" bold>
                    {activeSession.name}
                  </Text>
                  <Badge variant="secondary">
                    {activeSession.messageCount} messages
                  </Badge>
                  <Badge variant="secondary">
                    <FolderIcon size={12} weight="bold" className="mr-1" />
                    Workspace
                  </Badge>
                </>
              ) : (
                <Text size="lg" bold variant="secondary">
                  No session selected
                </Text>
              )}
            </div>
            <div className="flex items-center gap-3">
              <ConnectionIndicator status={connectionStatus} />
              <ModeToggle />
              <div className="relative" ref={mcpPanelRef}>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<PlugsConnectedIcon size={14} />}
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

                {showMcpPanel && (
                  <div className="absolute right-0 top-full mt-2 w-96 z-50">
                    <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-4">
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
                              isAddingServer ||
                              !mcpName.trim() ||
                              !mcpUrl.trim()
                            }
                          >
                            {isAddingServer ? "..." : "Add"}
                          </Button>
                        </div>
                      </form>

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

                      {mcpToolCount > 0 && (
                        <div className="pt-2 border-t border-kumo-line">
                          <div className="flex items-center gap-2">
                            <WrenchIcon
                              size={14}
                              className="text-kumo-subtle"
                            />
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
              {activeSession && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<BroomIcon size={14} />}
                  onClick={() => handleClear(activeSession.id)}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-6">
            {activeSessionId ? (
              <Messages messages={messages} status={status} />
            ) : (
              <Empty
                icon={<ChatTextIcon size={32} />}
                title="Create a session to start"
                description='Click "New" in the sidebar to create your first chat session'
              />
            )}
          </div>
        </div>

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
                  activeSessionId
                    ? "Ask me to create files, write code, or manage your workspace..."
                    : "Create a session first..."
                }
                disabled={!isConnected || isBusy || !activeSessionId}
                rows={2}
                className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none!"
              />
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={
                  !input.trim() || !isConnected || isBusy || !activeSessionId
                }
                icon={<PaperPlaneRightIcon size={18} />}
                loading={isBusy}
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
  );
}

export default function AppRoot() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <App />
    </Suspense>
  );
}

const root = document.getElementById("root")!;
createRoot(root).render(
  <ThemeProvider>
    <AppRoot />
  </ThemeProvider>
);
