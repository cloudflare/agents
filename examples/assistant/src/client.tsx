/**
 * Assistant — Client
 *
 * Chat UI for a Think agent showcasing all Project Think features.
 * Uses useAgentChat from @cloudflare/ai-chat which speaks the same
 * CF_AGENT protocol that Think implements.
 *
 * Features:
 *   - Chat with streaming responses
 *   - Server-side tools (weather, calculate, workspace, code execution)
 *   - Client-side tools (getUserTimezone via onToolCall)
 *   - Tool approval (calculate with large numbers)
 *   - Regeneration with branch navigation (v1/v2/v3)
 *   - MCP server management
 *   - Workspace file browser
 *   - Extension management
 *   - Dynamic configuration (model tier, persona)
 *   - Dark mode toggle
 */

import "./styles.css";
import { createRoot } from "react-dom/client";
import {
  Suspense,
  useCallback,
  useState,
  useEffect,
  useRef,
  type ReactNode
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import type { MCPServersState } from "agents";
import {
  Banner,
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text,
  PoweredByCloudflare
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  CheckCircleIcon,
  XCircleIcon,
  GearIcon,
  GithubLogoIcon,
  RobotIcon,
  PlugsConnectedIcon,
  PlusIcon,
  ShieldCheckIcon,
  SignInIcon,
  SignOutIcon,
  XIcon,
  WrenchIcon,
  MoonIcon,
  SunIcon,
  InfoIcon,
  ArrowsClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  FolderOpenIcon,
  PuzzlePieceIcon,
  SlidersHorizontalIcon,
  FileTextIcon,
  PencilIcon,
  ChatsIcon
} from "@phosphor-icons/react";
import {
  fetchCurrentUser,
  signOut,
  startGitHubLogin,
  type AuthUser
} from "./auth-client";
import { useChats } from "./use-chats";
import type { ChatSummary } from "./server";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  const text =
    status === "connected"
      ? "text-kumo-success"
      : status === "connecting"
        ? "text-kumo-warning"
        : "text-kumo-danger";
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";
  return (
    <div className="flex items-center gap-2" role="status">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className={`text-xs ${text}`}>{label}</span>
    </div>
  );
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("");
}

/** Text and reasoning parts use `state: streaming` with empty `text` until the first delta. */
function shouldShowStreamedTextPart(part: {
  text: string;
  state?: "streaming" | "done";
}): boolean {
  return part.text.length > 0 || part.state === "streaming";
}

function Chat({
  chatId,
  chatTitle,
  workspaceRevision,
  mcpState,
  addMcpServer,
  removeMcpServer,
  onRequestRename,
  onRequestDelete
}: {
  chatId: string;
  chatTitle: string;
  /**
   * Bumps whenever another chat (or this chat) mutates the shared
   * workspace. Used as a `useEffect` dep so the files panel stays
   * live across chats and open tabs without polling.
   */
  workspaceRevision: number;
  /**
   * Live MCP state for the whole user. Sourced from the directory's
   * `CF_AGENT_MCP_SERVERS` broadcasts; the same server list shows up
   * in every chat pane.
   */
  mcpState: MCPServersState;
  /**
   * Register a new MCP server on the directory. The returned
   * `authUrl`, if any, should be opened in a popup for the user to
   * complete OAuth.
   */
  addMcpServer: (
    name: string,
    url: string
  ) => Promise<{ id: string; state: string; authUrl?: string }>;
  /** Remove an MCP server from the shared registry. */
  removeMcpServer: (id: string) => Promise<void>;
  onRequestRename: () => void;
  onRequestDelete: () => void;
}) {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [isAddingServer, setIsAddingServer] = useState(false);
  const mcpPanelRef = useRef<HTMLDivElement>(null);

  const [showFilesPanel, setShowFilesPanel] = useState(false);
  const filesPanelRef = useRef<HTMLDivElement>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<
    { name: string; type: string; size?: number }[]
  >([]);
  const [fileContent, setFileContent] = useState<{
    path: string;
    content: string;
  } | null>(null);

  const [showExtensionsPanel, setShowExtensionsPanel] = useState(false);
  const extensionsPanelRef = useRef<HTMLDivElement>(null);
  const [extensions, setExtensions] = useState<
    { name: string; tools: string[] }[]
  >([]);

  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const configPanelRef = useRef<HTMLDivElement>(null);
  const [agentConfig, setAgentConfig] = useState<{
    modelTier: "fast" | "capable";
    persona: string;
  } | null>(null);

  const agent = useAgent({
    // This chat lives as a facet of the user's AssistantDirectory. The
    // `sub` option builds the nested URL tail `/sub/my-assistant/:chatId`.
    // The parent's `onBeforeSubAgent` strict-registry gate runs once on
    // connect; after the WebSocket upgrade, frames flow straight to the
    // child `MyAssistant` DO.
    //
    // MCP state (servers, tools, auth) is not received on this socket
    // any more — MCP lives on the directory now, so `useChats()` owns
    // the MCP broadcasts and we receive the resulting state as a prop.
    agent: "AssistantDirectory",
    basePath: "chat",
    sub: [{ agent: "MyAssistant", name: chatId }],
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

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

  useEffect(() => {
    if (!showFilesPanel) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        filesPanelRef.current &&
        !filesPanelRef.current.contains(e.target as Node)
      ) {
        setShowFilesPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showFilesPanel]);

  useEffect(() => {
    if (!showExtensionsPanel) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        extensionsPanelRef.current &&
        !extensionsPanelRef.current.contains(e.target as Node)
      ) {
        setShowExtensionsPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showExtensionsPanel]);

  useEffect(() => {
    if (!showConfigPanel) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        configPanelRef.current &&
        !configPanelRef.current.contains(e.target as Node)
      ) {
        setShowConfigPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showConfigPanel]);

  const refreshWorkspaceFiles = useCallback(async () => {
    try {
      const files = await agent.call("listWorkspaceFiles", ["/"]);
      setWorkspaceFiles(
        files as { name: string; type: string; size?: number }[]
      );
    } catch {
      setWorkspaceFiles([]);
    }
  }, [agent]);

  // Live-refresh the file browser when the shared workspace changes in
  // another chat (or this one). `workspaceRevision` is incremented by
  // `useChats()` each time the directory broadcasts a change event. We
  // only refetch if the panel is actually open — no point fetching just
  // to throw the result away, and `workspaceFiles` is still seeded on
  // panel-open via the existing click handler.
  useEffect(() => {
    if (!showFilesPanel) return;
    void refreshWorkspaceFiles();
  }, [showFilesPanel, workspaceRevision, refreshWorkspaceFiles]);

  const refreshExtensions = useCallback(async () => {
    try {
      const exts = await agent.call("listExtensions", []);
      setExtensions(exts as { name: string; tools: string[] }[]);
    } catch {
      setExtensions([]);
    }
  }, [agent]);

  const refreshConfig = useCallback(async () => {
    try {
      const config = await agent.call("currentConfig", []);
      setAgentConfig(
        config as { modelTier: "fast" | "capable"; persona: string } | null
      );
    } catch {
      setAgentConfig(null);
    }
  }, [agent]);

  const handleAddServer = async () => {
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    setIsAddingServer(true);
    try {
      const result = await addMcpServer(mcpName.trim(), mcpUrl.trim());
      setMcpName("");
      setMcpUrl("");
      // If the server needs OAuth, pop the auth URL open. Callback
      // lands at /chat/mcp-callback on the directory; our client-side
      // state refreshes via the directory's MCP broadcast.
      if (result.authUrl) {
        window.open(result.authUrl, "oauth", "width=600,height=800");
      }
    } catch (e) {
      console.error("Failed to add MCP server:", e);
    } finally {
      setIsAddingServer(false);
    }
  };

  const handleRemoveServer = async (serverId: string) => {
    try {
      await removeMcpServer(serverId);
    } catch (e) {
      console.error("Failed to remove MCP server:", e);
    }
  };

  const serverEntries = Object.entries(mcpState.servers);
  const mcpToolCount = mcpState.tools.length;

  const {
    messages,
    sendMessage,
    regenerate,
    clearHistory,
    addToolApprovalResponse,
    stop,
    isStreaming,
    error,
    clearError
  } = useAgentChat({
    agent,
    getInitialMessages: null,
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

  const isConnected = connectionStatus === "connected";

  // ── Branch navigation state ─────────────────────────────────────
  // Maps userMessageId -> { versions: UIMessage[], selectedIndex: number }
  const [branches, setBranches] = useState<
    Map<string, { versions: UIMessage[]; selectedIndex: number }>
  >(new Map());

  const fetchBranches = useCallback(
    async (userMessageId: string) => {
      try {
        const versions = (await agent.call("getResponseVersions", [
          userMessageId
        ])) as UIMessage[];
        if (versions.length > 1) {
          setBranches((prev) => {
            const next = new Map(prev);
            const existing = prev.get(userMessageId);
            next.set(userMessageId, {
              versions,
              selectedIndex: existing?.selectedIndex ?? versions.length - 1
            });
            return next;
          });
        }
      } catch {
        // Server may not support getBranches yet
      }
    },
    [agent]
  );

  // After messages update, fetch branches for user messages that precede
  // assistant messages. Only re-fetch when the message set actually changes
  // (keyed by the last message ID to avoid redundant RPC calls).
  const lastMessageId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (isStreaming || messages.length === 0) return;
    for (let i = 0; i < messages.length - 1; i++) {
      if (messages[i].role === "user" && messages[i + 1].role === "assistant") {
        fetchBranches(messages[i].id);
      }
    }
  }, [lastMessageId, isStreaming, fetchBranches, messages]);

  // Clear branch state on history clear
  const handleClearHistory = useCallback(() => {
    clearError();
    clearHistory();
    setBranches(new Map());
  }, [clearError, clearHistory]);

  const handleRegenerate = useCallback(() => {
    if (isStreaming) return;
    clearError();
    regenerate();
  }, [isStreaming, regenerate, clearError]);

  const selectBranch = useCallback((userMessageId: string, index: number) => {
    setBranches((prev) => {
      const next = new Map(prev);
      const entry = prev.get(userMessageId);
      if (entry) {
        next.set(userMessageId, { ...entry, selectedIndex: index });
      }
      return next;
    });
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    clearError();
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage, clearError]);

  return (
    <div className="flex flex-col h-full bg-kumo-elevated min-w-0">
      <header className="px-5 py-3 bg-kumo-base border-b border-kumo-line">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-base font-semibold text-kumo-default truncate">
              {chatTitle}
            </h2>
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              aria-label="Rename chat"
              icon={<PencilIcon size={12} />}
              onClick={onRequestRename}
            />
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              aria-label="Delete chat"
              icon={<TrashIcon size={12} />}
              onClick={onRequestDelete}
            />
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
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
                            isAddingServer || !mcpName.trim() || !mcpUrl.trim()
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
            <div className="relative" ref={filesPanelRef}>
              <Button
                variant="secondary"
                shape="square"
                aria-label="Workspace files"
                icon={<FolderOpenIcon size={16} />}
                onClick={() => {
                  setShowFilesPanel(!showFilesPanel);
                  if (!showFilesPanel) refreshWorkspaceFiles();
                }}
              />
              {showFilesPanel && (
                <div className="absolute right-0 top-full mt-2 w-80 z-50">
                  <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FolderOpenIcon
                          size={16}
                          className="text-kumo-accent"
                        />
                        <Text size="sm" bold>
                          Workspace
                        </Text>
                        <Badge variant="secondary">
                          {workspaceFiles.length}
                        </Badge>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        aria-label="Close"
                        icon={<XIcon size={14} />}
                        onClick={() => {
                          setShowFilesPanel(false);
                          setFileContent(null);
                        }}
                      />
                    </div>
                    {fileContent ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setFileContent(null)}
                          >
                            <CaretLeftIcon size={12} /> Back
                          </Button>
                          <span className="text-xs font-mono text-kumo-subtle truncate">
                            {fileContent.path}
                          </span>
                        </div>
                        <pre className="text-xs font-mono bg-kumo-elevated p-3 rounded-lg overflow-auto max-h-60 whitespace-pre-wrap">
                          {fileContent.content}
                        </pre>
                      </div>
                    ) : workspaceFiles.length === 0 ? (
                      <span className="text-xs text-kumo-subtle block">
                        No files yet. Ask the assistant to create some.
                      </span>
                    ) : (
                      <div className="space-y-1 max-h-60 overflow-y-auto">
                        {workspaceFiles.map((f) => (
                          <button
                            key={f.name}
                            className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-kumo-elevated text-left transition-colors"
                            onClick={async () => {
                              if (f.type === "file") {
                                const content = await agent.call(
                                  "readWorkspaceFile",
                                  [`/${f.name}`]
                                );
                                if (content)
                                  setFileContent({
                                    path: `/${f.name}`,
                                    content: content as string
                                  });
                              }
                            }}
                          >
                            <FileTextIcon
                              size={14}
                              className="text-kumo-subtle shrink-0"
                            />
                            <span className="text-sm text-kumo-default truncate">
                              {f.name}
                            </span>
                            {f.size != null && (
                              <span className="text-xs text-kumo-inactive ml-auto">
                                {f.size}b
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </Surface>
                </div>
              )}
            </div>
            <div className="relative" ref={extensionsPanelRef}>
              <Button
                variant="secondary"
                shape="square"
                aria-label="Extensions"
                icon={<PuzzlePieceIcon size={16} />}
                onClick={() => {
                  setShowExtensionsPanel(!showExtensionsPanel);
                  if (!showExtensionsPanel) refreshExtensions();
                }}
              />
              {showExtensionsPanel && (
                <div className="absolute right-0 top-full mt-2 w-80 z-50">
                  <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <PuzzlePieceIcon
                          size={16}
                          className="text-kumo-accent"
                        />
                        <Text size="sm" bold>
                          Extensions
                        </Text>
                        <Badge variant="secondary">{extensions.length}</Badge>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        aria-label="Close"
                        icon={<XIcon size={14} />}
                        onClick={() => setShowExtensionsPanel(false)}
                      />
                    </div>
                    {extensions.length === 0 ? (
                      <span className="text-xs text-kumo-subtle block">
                        No extensions loaded. Ask the assistant to create one,
                        e.g. "Create an extension that converts temperatures."
                      </span>
                    ) : (
                      <div className="space-y-2 max-h-60 overflow-y-auto">
                        {extensions.map((ext) => (
                          <div
                            key={ext.name}
                            className="p-2.5 rounded-lg border border-kumo-line"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-kumo-default">
                                {ext.name}
                              </span>
                              <Badge variant="primary">
                                {ext.tools.length} tools
                              </Badge>
                            </div>
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {ext.tools.map((t) => (
                                <Badge key={t} variant="secondary">
                                  {t}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Surface>
                </div>
              )}
            </div>
            <div className="relative" ref={configPanelRef}>
              <Button
                variant="secondary"
                shape="square"
                aria-label="Configuration"
                icon={<SlidersHorizontalIcon size={16} />}
                onClick={() => {
                  setShowConfigPanel(!showConfigPanel);
                  if (!showConfigPanel) refreshConfig();
                }}
              />
              {showConfigPanel && (
                <div className="absolute right-0 top-full mt-2 w-80 z-50">
                  <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <SlidersHorizontalIcon
                          size={16}
                          className="text-kumo-accent"
                        />
                        <Text size="sm" bold>
                          Configuration
                        </Text>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        aria-label="Close"
                        icon={<XIcon size={14} />}
                        onClick={() => setShowConfigPanel(false)}
                      />
                    </div>
                    <div className="space-y-3">
                      <div>
                        <label
                          htmlFor="model-tier"
                          className="text-xs font-medium text-kumo-subtle block mb-1"
                        >
                          Model tier
                        </label>
                        <div className="flex gap-2">
                          {(["fast", "capable"] as const).map((tier) => (
                            <Button
                              key={tier}
                              variant={
                                (agentConfig?.modelTier ?? "fast") === tier
                                  ? "primary"
                                  : "secondary"
                              }
                              size="sm"
                              onClick={async () => {
                                const newConfig = {
                                  modelTier: tier,
                                  persona: agentConfig?.persona ?? ""
                                };
                                await agent.call("updateConfig", [newConfig]);
                                setAgentConfig(newConfig);
                              }}
                            >
                              {tier}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label
                          htmlFor="persona"
                          className="text-xs font-medium text-kumo-subtle block mb-1"
                        >
                          Persona
                        </label>
                        <textarea
                          className="w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent resize-none"
                          rows={3}
                          placeholder="You are a helpful assistant..."
                          value={agentConfig?.persona ?? ""}
                          onChange={(e) =>
                            setAgentConfig((prev) => ({
                              modelTier: prev?.modelTier ?? "fast",
                              persona: e.target.value
                            }))
                          }
                          onBlur={async () => {
                            if (agentConfig) {
                              await agent.call("updateConfig", [agentConfig]);
                            }
                          }}
                        />
                      </div>
                    </div>
                  </Surface>
                </div>
              )}
            </div>
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={handleClearHistory}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
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
                      Think Assistant
                    </Text>
                    <span className="mt-1 block">
                      <Text size="xs" variant="secondary">
                        A showcase of all Project Think features: workspace
                        tools, sandboxed code execution, self-authored
                        extensions, persistent memory, conversation compaction,
                        full-text search, dynamic configuration, tool approval,
                        response regeneration with version history, and MCP
                        integration. Try "Execute some code to list all .ts
                        files" or "Create an extension for temperature
                        conversion."
                      </Text>
                    </span>
                  </div>
                </div>
              </Surface>
              <Empty
                icon={<RobotIcon size={32} />}
                title="Start a conversation"
                description='Try "Write a hello.txt file", "Execute code to find all TODOs", or "Create an extension for unit conversion"'
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

            const parentMessageIndex = index > 0 ? index - 1 : -1;
            const parentMessageId =
              parentMessageIndex >= 0
                ? messages[parentMessageIndex].id
                : undefined;
            const branchInfo = parentMessageId
              ? branches.get(parentMessageId)
              : undefined;
            const displayMessage =
              branchInfo &&
              branchInfo.selectedIndex < branchInfo.versions.length - 1
                ? branchInfo.versions[branchInfo.selectedIndex]
                : message;

            return (
              <div key={message.id} className="space-y-2">
                {displayMessage.parts.map((part, partIndex) => {
                  if (part.type === "text") {
                    if (!shouldShowStreamedTextPart(part)) return null;
                    const isLastTextPart = displayMessage.parts
                      .slice(partIndex + 1)
                      .every((p) => p.type !== "text");
                    return (
                      <div key={partIndex} className="flex justify-start">
                        <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                          <div className="whitespace-pre-wrap min-h-[1.25em]">
                            {part.text ||
                              (part.state === "streaming" ? "\u00a0" : null)}
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

                  if (part.type === "reasoning") {
                    if (!shouldShowStreamedTextPart(part)) return null;
                    return (
                      <div key={partIndex} className="flex justify-start">
                        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line opacity-70">
                          <div className="flex items-center gap-2 mb-1">
                            <GearIcon
                              size={14}
                              className="text-kumo-inactive"
                            />
                            <Text size="xs" variant="secondary" bold>
                              Reasoning
                            </Text>
                          </div>
                          <div className="whitespace-pre-wrap text-xs text-kumo-subtle italic min-h-[1em]">
                            {part.text ||
                              (part.state === "streaming" ? "…" : null)}
                          </div>
                        </Surface>
                      </div>
                    );
                  }

                  if (!isToolUIPart(part)) return null;
                  const toolName = getToolName(part);

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
                          {part.input != null && (
                            <div className="font-mono mb-1.5 pb-1.5 border-b border-kumo-line">
                              <span className="text-[10px] uppercase tracking-wider text-kumo-inactive block mb-0.5">
                                Input
                              </span>
                              <pre className="text-xs text-kumo-subtle whitespace-pre-wrap">
                                {JSON.stringify(part.input, null, 2)}
                              </pre>
                            </div>
                          )}
                          <div className="font-mono">
                            <span className="text-[10px] uppercase tracking-wider text-kumo-inactive block mb-0.5">
                              Output
                            </span>
                            <pre className="text-xs text-kumo-subtle whitespace-pre-wrap">
                              {JSON.stringify(part.output, null, 2)}
                            </pre>
                          </div>
                        </Surface>
                      </div>
                    );
                  }

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

                  if (
                    part.state === "input-available" ||
                    part.state === "input-streaming"
                  ) {
                    return (
                      <div key={part.toolCallId} className="flex justify-start">
                        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
                          <div className="flex items-center gap-2 mb-1">
                            <GearIcon
                              size={14}
                              className="text-kumo-inactive animate-spin"
                            />
                            <Text size="xs" variant="secondary" bold>
                              Running {toolName}...
                            </Text>
                          </div>
                          {part.input != null && (
                            <div className="font-mono">
                              <span className="text-[10px] uppercase tracking-wider text-kumo-inactive block mb-0.5">
                                Input
                              </span>
                              <pre className="text-xs text-kumo-subtle whitespace-pre-wrap">
                                {JSON.stringify(part.input, null, 2)}
                              </pre>
                            </div>
                          )}
                        </Surface>
                      </div>
                    );
                  }

                  return null;
                })}

                {!isStreaming &&
                  message.role === "assistant" &&
                  parentMessageIndex >= 0 &&
                  (isLastAssistant ||
                    (branchInfo && branchInfo.versions.length > 1)) && (
                    <div className="flex items-center gap-1 mt-1 ml-1">
                      {isLastAssistant && (
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          aria-label="Regenerate response"
                          icon={<ArrowsClockwiseIcon size={14} />}
                          onClick={handleRegenerate}
                        />
                      )}
                      {branchInfo && branchInfo.versions.length > 1 && (
                        <div className="flex items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            shape="square"
                            aria-label="Previous version"
                            disabled={branchInfo.selectedIndex === 0}
                            icon={<CaretLeftIcon size={12} />}
                            onClick={() =>
                              parentMessageId &&
                              selectBranch(
                                parentMessageId,
                                branchInfo.selectedIndex - 1
                              )
                            }
                          />
                          <span className="text-xs text-kumo-subtle tabular-nums px-0.5">
                            {branchInfo.selectedIndex + 1}/
                            {branchInfo.versions.length}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            shape="square"
                            aria-label="Next version"
                            disabled={
                              branchInfo.selectedIndex ===
                              branchInfo.versions.length - 1
                            }
                            icon={<CaretRightIcon size={12} />}
                            onClick={() =>
                              parentMessageId &&
                              selectBranch(
                                parentMessageId,
                                branchInfo.selectedIndex + 1
                              )
                            }
                          />
                        </div>
                      )}
                    </div>
                  )}
              </div>
            );
          })}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t border-kumo-line bg-kumo-base">
        {error && (
          <div
            className="max-w-3xl mx-auto px-5 pt-3"
            role="alert"
            aria-live="polite"
          >
            <Surface className="rounded-lg ring ring-kumo-danger/50 bg-red-500/10 px-3 py-2">
              <Text size="xs" variant="error">
                {error.message}
              </Text>
            </Surface>
          </div>
        )}
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
              placeholder="Try: What's the weather in Paris? Or: Write a hello.txt file"
              disabled={!isConnected || isStreaming}
              rows={2}
              className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none!"
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
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </div>
    </div>
  );
}

function AuthShell({
  children,
  align = "center"
}: {
  children: ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div className="flex flex-col min-h-screen bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="flex items-center justify-end">
          <ModeToggle />
        </div>
      </header>
      <div
        className={`flex-1 py-12 ${
          align === "center" ? "flex items-center justify-center" : ""
        }`}
      >
        <div className="w-full max-w-lg px-6">{children}</div>
      </div>
      <div className="flex justify-center pb-3">
        <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
      </div>
    </div>
  );
}

function LoadingView({ message = "Loading..." }: { message?: string }) {
  return (
    <AuthShell>
      <Surface className="px-10 py-12 rounded-2xl ring ring-kumo-line">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-kumo-brand/10">
            <ShieldCheckIcon
              size={20}
              weight="bold"
              className="text-kumo-brand"
            />
          </div>
          <Text variant="heading1">Assistant</Text>
        </div>
        <Text variant="secondary">{message}</Text>
      </Surface>
    </AuthShell>
  );
}

function SignInView({ error }: { error: string | null }) {
  return (
    <AuthShell>
      <Surface className="px-10 py-12 rounded-2xl ring ring-kumo-line">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-kumo-brand/10">
              <GithubLogoIcon
                size={20}
                weight="fill"
                className="text-kumo-brand"
              />
            </div>
            <Text variant="heading1">Assistant</Text>
          </div>
          <Text variant="secondary">
            Sign in with GitHub, then connect to a user-scoped Think assistant
            chosen by the Worker. No local token storage, no browser-chosen room
            names.
          </Text>
        </div>

        <Surface className="p-4 rounded-xl ring ring-kumo-line">
          <div className="flex gap-3">
            <InfoIcon
              size={20}
              weight="bold"
              className="text-kumo-accent shrink-0 mt-0.5"
            />
            <div>
              <Text size="sm" bold>
                Before you start
              </Text>
              <span className="mt-1 block">
                <Text size="xs" variant="secondary">
                  Create a GitHub OAuth App and add `GITHUB_CLIENT_ID` plus
                  `GITHUB_CLIENT_SECRET` to `.env`. The README walks through the
                  exact callback URL to use for local development.
                </Text>
              </span>
            </div>
          </div>
        </Surface>

        {error && (
          <div className="mt-6">
            <Banner variant="error">{error}</Banner>
          </div>
        )}

        <div className="border-t border-kumo-line my-8" />

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          icon={<GithubLogoIcon size={18} weight="fill" />}
          onClick={startGitHubLogin}
        >
          Sign in with GitHub
        </Button>
      </Surface>
    </AuthShell>
  );
}

// ── Sidebar (chat list + new-chat action) ──────────────────────────────

function ChatSidebar({
  chats,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  user,
  onSignOut
}: {
  chats: ChatSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (chat: ChatSummary) => void;
  onDelete: (chat: ChatSummary) => void;
  user: AuthUser;
  onSignOut: () => Promise<void>;
}) {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const displayName = user.name || user.login;

  const handleSignOut = useCallback(async () => {
    setIsSigningOut(true);
    try {
      await onSignOut();
    } catch (err) {
      console.error("Failed to sign out:", err);
    } finally {
      setIsSigningOut(false);
    }
  }, [onSignOut]);

  return (
    <aside className="flex flex-col h-full w-64 shrink-0 border-r border-kumo-line bg-kumo-base">
      <div className="px-3 py-3 border-b border-kumo-line flex items-center gap-2">
        <RobotIcon size={20} className="text-kumo-brand" />
        <h1 className="text-sm font-semibold text-kumo-default">Assistant</h1>
        <Badge variant="secondary">Think</Badge>
      </div>

      <div className="px-3 py-2 border-b border-kumo-line">
        <Button
          variant="primary"
          size="sm"
          icon={<PlusIcon size={14} />}
          onClick={onCreate}
          className="w-full"
        >
          New chat
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {chats.length === 0 ? (
          <div className="p-4 flex flex-col items-center text-center gap-2">
            <ChatsIcon size={24} className="text-kumo-inactive" />
            <Text size="xs" variant="secondary">
              No chats yet. Click <strong>New chat</strong> to start one.
            </Text>
          </div>
        ) : (
          <ul className="py-1">
            {chats.map((chat) => {
              const isActive = chat.id === activeId;
              return (
                <li key={chat.id} className="group relative">
                  <button
                    type="button"
                    className={`w-full flex items-start gap-1 px-2 py-2 mx-1 rounded-md text-left ${
                      isActive ? "bg-kumo-hover" : "hover:bg-kumo-hover/60"
                    }`}
                    onClick={() => onSelect(chat.id)}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <div className="min-w-0 flex-1">
                      <Text size="sm" bold>
                        <span className="truncate block">{chat.title}</span>
                      </Text>
                      <span className="mt-0.5 truncate block">
                        <Text size="xs" variant="secondary">
                          {chat.lastMessagePreview ?? "No messages yet"}
                        </Text>
                      </span>
                    </div>
                  </button>
                  {/* Row actions sit outside the main button so nested
                      buttons don't get flagged as a11y violations. */}
                  <div className="absolute right-2 top-2 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="square"
                      aria-label="Rename chat"
                      icon={<PencilIcon size={12} />}
                      onClick={() => onRename(chat)}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="square"
                      aria-label="Delete chat"
                      icon={<TrashIcon size={12} />}
                      onClick={() => onDelete(chat)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="px-3 py-3 border-t border-kumo-line flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <GithubLogoIcon size={14} className="text-kumo-inactive shrink-0" />
          <Text size="xs" variant="secondary">
            <span className="truncate block">{displayName}</span>
          </Text>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <ModeToggle />
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            aria-label="Sign out"
            icon={<SignOutIcon size={14} />}
            onClick={handleSignOut}
            loading={isSigningOut}
          />
        </div>
      </div>
    </aside>
  );
}

// ── Multi-chat shell (sidebar + active chat) ───────────────────────────

function MultiChatApp({
  user,
  onSignOut
}: {
  user: AuthUser;
  onSignOut: () => void;
}) {
  const {
    directory,
    chats,
    workspaceRevision,
    mcpState,
    createChat,
    renameChat,
    deleteChat,
    addMcpServer,
    removeMcpServer
  } = useChats();
  const [activeId, setActiveId] = useState<string | null>(null);

  // Auto-select the most-recently-active chat when the sidebar loads or
  // when the currently-active chat is deleted from under us. The
  // directory's state is the source of truth — we never invent an id
  // client-side.
  useEffect(() => {
    if (chats.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!activeId || !chats.some((c) => c.id === activeId)) {
      setActiveId(chats[0].id);
    }
  }, [chats, activeId]);

  const handleCreate = useCallback(async () => {
    try {
      const created = await createChat();
      setActiveId(created.id);
    } catch (err) {
      console.error("Failed to create chat:", err);
    }
  }, [createChat]);

  const handleRename = useCallback(
    async (chat: ChatSummary) => {
      const next = window.prompt("Rename chat", chat.title);
      if (next === null) return;
      const trimmed = next.trim();
      if (!trimmed || trimmed === chat.title) return;
      try {
        await renameChat(chat.id, trimmed);
      } catch (err) {
        console.error("Failed to rename chat:", err);
      }
    },
    [renameChat]
  );

  const handleDelete = useCallback(
    async (chat: ChatSummary) => {
      if (!window.confirm(`Delete "${chat.title}"? This cannot be undone.`)) {
        return;
      }
      try {
        await deleteChat(chat.id);
      } catch (err) {
        console.error("Failed to delete chat:", err);
      }
    },
    [deleteChat]
  );

  const activeChat =
    activeId !== null ? chats.find((c) => c.id === activeId) : undefined;
  const directoryReady = directory.readyState === 1;

  const handleSignOut = useCallback(async () => {
    try {
      await signOut();
    } finally {
      onSignOut();
    }
  }, [onSignOut]);

  return (
    <div className="flex h-screen bg-kumo-elevated">
      <ChatSidebar
        chats={chats}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={handleCreate}
        onRename={handleRename}
        onDelete={handleDelete}
        user={user}
        onSignOut={handleSignOut}
      />
      <div className="flex-1 min-w-0">
        {activeChat ? (
          // `key={activeChat.id}` forces a full remount across chat
          // switches so the chat's local state (MCP panel, file browser,
          // branch map, input draft) all reset cleanly.
          <Suspense
            key={activeChat.id}
            fallback={<LoadingView message="Loading chat…" />}
          >
            <Chat
              chatId={activeChat.id}
              chatTitle={activeChat.title}
              workspaceRevision={workspaceRevision}
              mcpState={mcpState}
              addMcpServer={addMcpServer}
              removeMcpServer={removeMcpServer}
              onRequestRename={() => handleRename(activeChat)}
              onRequestDelete={() => handleDelete(activeChat)}
            />
          </Suspense>
        ) : (
          <EmptyChatView
            ready={directoryReady}
            onCreate={handleCreate}
            hasChats={chats.length > 0}
          />
        )}
      </div>
    </div>
  );
}

function EmptyChatView({
  ready,
  onCreate,
  hasChats
}: {
  ready: boolean;
  onCreate: () => void;
  hasChats: boolean;
}) {
  if (!ready) {
    return <LoadingView message="Connecting…" />;
  }
  if (hasChats) {
    // Transient — the sidebar auto-selects a chat on the next tick.
    return <LoadingView message="Opening chat…" />;
  }
  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="max-w-md flex flex-col items-center gap-4">
        <Empty
          icon={<ChatsIcon size={28} />}
          title="No chats yet"
          description="Each chat is its own isolated workspace — extensions, MCP servers, and messages don't leak across."
        />
        <Button
          variant="primary"
          icon={<PlusIcon size={14} />}
          onClick={onCreate}
        >
          New chat
        </Button>
      </div>
    </div>
  );
}

function AuthenticatedApp() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    const loadUser = async () => {
      try {
        const currentUser = await fetchCurrentUser(controller.signal);
        setUser(currentUser);
        setError(null);
      } catch (loadError) {
        if (
          loadError instanceof DOMException &&
          loadError.name === "AbortError"
        ) {
          return;
        }
        setUser(null);
        setError("Failed to load the current auth state");
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    void loadUser();
    return () => controller.abort();
  }, []);

  if (isLoading) {
    return <LoadingView message="Checking your authentication status…" />;
  }

  if (user) {
    return (
      <MultiChatApp
        user={user}
        onSignOut={() => {
          setUser(null);
          setError(null);
        }}
      />
    );
  }

  return <SignInView error={error} />;
}

export default function App() {
  return <AuthenticatedApp />;
}

const root = document.getElementById("root")!;
createRoot(root).render(<App />);
