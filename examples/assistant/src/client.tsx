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
  RobotIcon,
  PlugsConnectedIcon,
  PlusIcon,
  SignInIcon,
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
  FileTextIcon
} from "@phosphor-icons/react";

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
    agent: "MyAssistant",
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
      await agent.call("addServer", [mcpName.trim(), mcpUrl.trim()]);
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
    regenerate,
    clearHistory,
    addToolApprovalResponse,
    stop,
    isStreaming,
    error,
    clearError
  } = useAgentChat({
    agent,
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
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <RobotIcon size={24} className="text-kumo-brand" />
            <h1 className="text-lg font-semibold text-kumo-default">
              Assistant
            </h1>
            <Badge variant="secondary">Think</Badge>
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

const root = document.getElementById("root")!;
createRoot(root).render(<App />);
