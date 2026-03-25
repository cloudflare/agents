import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart } from "ai";
import "./styles.css";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  createContext,
  useContext
} from "react";
import { Streamdown } from "streamdown";
import {
  Button,
  Surface,
  Text,
  InputArea,
  Empty,
  Badge
} from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon,
  TrashIcon,
  GearIcon,
  LightningIcon,
  CaretRightIcon,
  XIcon,
  CodeIcon,
  TerminalIcon,
  WarningCircleIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  BrainIcon,
  CaretDownIcon,
  PlugsConnectedIcon,
  PlusIcon,
  CubeIcon,
  SpinnerGapIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon
} from "@phosphor-icons/react";
import type { ExecutorType } from "./server";

// ── Theme ──

type Mode = "light" | "dark" | "system";

interface ThemeContextValue {
  mode: Mode;
  resolvedMode: "light" | "dark";
  setMode: (mode: Mode) => void;
}

const STORAGE_KEY = "theme";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getStoredMode(): Mode {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<Mode>(getStoredMode);
  const [resolvedMode, setResolvedMode] = useState<"light" | "dark">(() =>
    mode === "system" ? getSystemTheme() : mode
  );

  const setMode = (newMode: Mode) => {
    setModeState(newMode);
    localStorage.setItem(STORAGE_KEY, newMode);
  };

  useEffect(() => {
    const updateResolved = () => {
      const resolved = mode === "system" ? getSystemTheme() : mode;
      setResolvedMode(resolved);
      document.documentElement.setAttribute("data-mode", resolved);
      document.documentElement.style.colorScheme = resolved;
    };

    updateResolved();

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (mode === "system") {
        updateResolved();
      }
    };

    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, [mode]);

  return (
    <ThemeContext.Provider value={{ mode, resolvedMode, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

// ── ConnectionIndicator ──

type ConnectionStatus = "connecting" | "connected" | "disconnected";

const statusConfig: Record<
  ConnectionStatus,
  { label: string; dotClass: string; textClass: string }
> = {
  connecting: {
    label: "Connecting...",
    dotClass: "bg-yellow-500",
    textClass: "text-kumo-warning"
  },
  connected: {
    label: "Connected",
    dotClass: "bg-green-500",
    textClass: "text-kumo-success"
  },
  disconnected: {
    label: "Disconnected",
    dotClass: "bg-red-500",
    textClass: "text-kumo-danger"
  }
};

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const { label, dotClass, textClass } = statusConfig[status];
  return (
    <div className="flex items-center gap-2" role="status" aria-live="polite">
      <span className={`size-2 rounded-full ${dotClass}`} aria-hidden="true" />
      <span className={textClass}>{label}</span>
    </div>
  );
}

// ── ModeToggle ──

function ModeToggle() {
  const { mode, setMode } = useTheme();

  const cycle = () => {
    const modes = ["system", "light", "dark"] as const;
    const idx = modes.indexOf(mode);
    setMode(modes[(idx + 1) % modes.length]);
  };

  const icon =
    mode === "light" ? (
      <SunIcon size={16} />
    ) : mode === "dark" ? (
      <MoonIcon size={16} />
    ) : (
      <MonitorIcon size={16} />
    );

  const label =
    mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System";

  return (
    <Button
      variant="secondary"
      icon={icon}
      onClick={cycle}
      title={`Theme: ${label}`}
    >
      {label}
    </Button>
  );
}

// ── PoweredByAgents ──

function PoweredByAgents() {
  return (
    <a
      href="https://developers.cloudflare.com/agents/"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-3 text-xs text-kumo-inactive transition-colors hover:text-kumo-subtle"
    >
      <svg
        viewBox="0 0 49 22"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Cloudflare"
        className="h-5 w-auto shrink-0"
      >
        <path
          d="M33.204 20.4C33.3649 19.9741 33.4217 19.5159 33.3695 19.0636C33.3173 18.6113 33.1577 18.1781 32.904 17.8C32.6435 17.4876 32.3239 17.2297 31.9636 17.0409C31.6032 16.8522 31.2092 16.7363 30.804 16.7L13.404 16.5C13.304 16.5 13.204 16.4 13.104 16.4C13.0808 16.3825 13.0618 16.3599 13.0488 16.3339C13.0358 16.3078 13.029 16.2791 13.029 16.25C13.029 16.2209 13.0358 16.1922 13.0488 16.1662C13.0618 16.1401 13.0808 16.1175 13.104 16.1C13.204 15.9 13.304 15.8 13.504 15.8L31.004 15.6C32.115 15.4767 33.1731 15.0597 34.0695 14.3918C34.9659 13.7239 35.6681 12.8293 36.104 11.8L37.104 9.20002C37.104 9.10002 37.204 9.00001 37.104 8.90001C36.5604 6.47843 35.2411 4.30052 33.3466 2.69721C31.4521 1.09391 29.086 0.152865 26.6079 0.0170769C24.1298 -0.118712 21.675 0.558179 19.6167 1.94489C17.5584 3.33161 16.009 5.35233 15.204 7.70002C14.159 6.95365 12.8843 6.59957 11.604 6.70002C10.4291 6.83102 9.33369 7.35777 8.49774 8.19372C7.66179 9.02966 7.13505 10.1251 7.00404 11.3C6.93745 11.9014 6.97125 12.5097 7.10404 13.1C5.20298 13.1526 3.39743 13.9448 2.07147 15.3081C0.745511 16.6714 0.00377461 18.4982 0.00403983 20.4C-0.0123708 20.7695 0.0212659 21.1395 0.104038 21.5C0.10863 21.5781 0.141713 21.6517 0.19701 21.707C0.252307 21.7623 0.325975 21.7954 0.404041 21.8H32.504C32.704 21.8 32.904 21.7 32.904 21.5L33.204 20.4Z"
          fill="#F48120"
        />
        <path
          d="M38.704 9.20002H38.204C38.104 9.20002 38.004 9.30001 37.904 9.40001L37.204 11.8C37.0431 12.2259 36.9864 12.6841 37.0386 13.1364C37.0908 13.5887 37.2504 14.0219 37.504 14.4C37.7646 14.7124 38.0842 14.9704 38.4445 15.1591C38.8049 15.3479 39.1989 15.4637 39.604 15.5L43.304 15.7C43.404 15.7 43.504 15.8 43.604 15.8C43.6273 15.8175 43.6462 15.8401 43.6592 15.8662C43.6723 15.8922 43.679 15.9209 43.679 15.95C43.679 15.9791 43.6723 16.0078 43.6592 16.0339C43.6462 16.0599 43.6273 16.0826 43.604 16.1C43.504 16.3 43.404 16.4 43.204 16.4L39.404 16.6C38.293 16.7233 37.2349 17.1403 36.3386 17.8082C35.4422 18.4761 34.74 19.3707 34.304 20.4L34.104 21.3C34.004 21.4 34.104 21.6 34.304 21.6H47.504C47.5448 21.6058 47.5863 21.6021 47.6254 21.5891C47.6644 21.5761 47.6999 21.5541 47.729 21.525C47.7581 21.4959 47.7801 21.4604 47.7931 21.4214C47.8061 21.3823 47.8099 21.3408 47.804 21.3C48.0421 20.4527 48.1764 19.5797 48.204 18.7C48.1882 16.1854 47.1822 13.7782 45.404 12C43.6259 10.2218 41.2187 9.21587 38.704 9.20002Z"
          fill="#FAAD3F"
        />
      </svg>
      <span className="flex flex-col whitespace-nowrap leading-snug">
        <span>Powered by</span>
        <span className="font-semibold text-kumo-default">
          Cloudflare Agents
        </span>
      </span>
    </a>
  );
}

interface McpTool {
  serverId: string;
  name: string;
  description?: string;
}

interface ToolPart {
  type: string;
  toolCallId?: string;
  state?: string;
  errorText?: string;
  input?: { functionDescription?: string; [key: string]: unknown };
  output?: {
    code?: string;
    result?: string;
    logs?: string[];
    [key: string]: unknown;
  };
}

const EXECUTORS: { value: ExecutorType; label: string; description: string }[] =
  [
    {
      value: "dynamic-worker",
      label: "Dynamic Worker",
      description: "Sandboxed Cloudflare Worker via WorkerLoader"
    },
    {
      value: "node-server",
      label: "Node Server",
      description: "Node.js VM via external HTTP server"
    }
  ];

const TOOLS: { name: string; description: string }[] = [
  { name: "createProject", description: "Create a new project" },
  { name: "listProjects", description: "List all projects" },
  { name: "createTask", description: "Create a task in a project" },
  { name: "listTasks", description: "List tasks with optional filters" },
  { name: "updateTask", description: "Update a task's fields" },
  { name: "deleteTask", description: "Delete a task and its comments" },
  { name: "createSprint", description: "Create a sprint for a project" },
  { name: "listSprints", description: "List sprints, optionally by project" },
  { name: "addComment", description: "Add a comment to a task" },
  { name: "listComments", description: "List comments on a task" }
];

function extractFunctionCalls(code?: string): string[] {
  if (!code) return [];
  const matches = code.match(/codemode\.(\w+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace("codemode.", "")))];
}

function ReasoningBlock({
  text,
  isStreaming
}: {
  text: string;
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!text?.trim()) return null;

  return (
    <div className="flex justify-start">
      <Surface className="max-w-[80%] rounded-xl bg-purple-500/10 border border-purple-500/20 overflow-hidden">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer"
        >
          <BrainIcon size={14} className="text-purple-400" />
          <Text size="xs" bold>
            Thinking
          </Text>
          <CaretDownIcon
            size={12}
            className={`ml-auto text-kumo-secondary transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
        {expanded && (
          <div className="px-3 pb-3">
            <Streamdown
              className="sd-theme text-xs"
              controls={false}
              isAnimating={isStreaming}
            >
              {text}
            </Streamdown>
          </div>
        )}
      </Surface>
    </div>
  );
}

function ToolCard({ toolPart }: { toolPart: ToolPart }) {
  const [expanded, setExpanded] = useState(false);
  const hasError = toolPart.state === "output-error" || !!toolPart.errorText;
  const isComplete = toolPart.state === "output-available";
  const isRunning = !isComplete && !hasError;

  const functionCalls = extractFunctionCalls(
    toolPart.output?.code || (toolPart.input?.code as string)
  );
  const summary =
    functionCalls.length > 0 ? functionCalls.join(", ") : "code execution";

  return (
    <Surface
      className={`rounded-xl ring ${hasError ? "ring-2 ring-red-500/30" : "ring-kumo-line"} overflow-hidden`}
    >
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-kumo-elevated transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <CaretRightIcon
          size={12}
          className={`text-kumo-secondary transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <LightningIcon size={14} className="text-kumo-inactive" />
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <Text size="xs" bold>
            Ran code
          </Text>
          {functionCalls.length > 0 && (
            <>
              <span className="text-kumo-inactive">&middot;</span>
              <span className="font-mono text-xs text-kumo-secondary truncate">
                {summary}
              </span>
            </>
          )}
        </div>
        {isComplete && (
          <CheckCircleIcon size={14} className="text-green-500 shrink-0" />
        )}
        {hasError && (
          <WarningCircleIcon size={14} className="text-red-500 shrink-0" />
        )}
        {isRunning && (
          <CircleNotchIcon
            size={14}
            className="text-kumo-inactive animate-spin shrink-0"
          />
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-kumo-line space-y-2 pt-2">
          {toolPart.output?.code && (
            <div>
              <div className="flex items-center gap-1 mb-1">
                <CodeIcon size={10} className="text-kumo-inactive" />
                <Text size="xs" variant="secondary" bold>
                  Code
                </Text>
              </div>
              <pre className="font-mono text-xs text-kumo-subtle bg-kumo-elevated rounded p-2 overflow-x-auto whitespace-pre-wrap wrap-break-word">
                {toolPart.output.code}
              </pre>
            </div>
          )}
          {!toolPart.output?.code && toolPart.input && (
            <div>
              <Text size="xs" variant="secondary" bold>
                Input
              </Text>
              <pre className="font-mono text-xs text-kumo-subtle bg-kumo-elevated rounded p-2 overflow-x-auto whitespace-pre-wrap mt-1">
                {JSON.stringify(toolPart.input, null, 2)}
              </pre>
            </div>
          )}
          {toolPart.output?.result !== undefined && (
            <div>
              <Text size="xs" variant="secondary" bold>
                Result
              </Text>
              <pre className="font-mono text-xs text-kumo-subtle bg-green-500/5 border border-green-500/20 rounded p-2 overflow-x-auto whitespace-pre-wrap mt-1">
                {JSON.stringify(toolPart.output.result, null, 2)}
              </pre>
            </div>
          )}
          {toolPart.output?.logs && toolPart.output.logs.length > 0 && (
            <div>
              <div className="flex items-center gap-1 mb-1">
                <TerminalIcon size={10} className="text-kumo-inactive" />
                <Text size="xs" variant="secondary" bold>
                  Console
                </Text>
              </div>
              <pre className="font-mono text-xs text-kumo-subtle bg-kumo-elevated rounded p-2 overflow-x-auto whitespace-pre-wrap">
                {toolPart.output.logs.join("\n")}
              </pre>
            </div>
          )}
          {toolPart.errorText && (
            <div>
              <Text size="xs" variant="secondary" bold>
                Error
              </Text>
              <pre className="font-mono text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2 overflow-x-auto whitespace-pre-wrap mt-1">
                {toolPart.errorText}
              </pre>
            </div>
          )}
        </div>
      )}
    </Surface>
  );
}

function SettingsPanel({
  executor,
  onExecutorChange,
  loading,
  onClose,
  mcpTools,
  onAddMcp,
  onRemoveMcp,
  onRefreshMcpTools,
  mcpLoading
}: {
  executor: ExecutorType;
  onExecutorChange: (e: ExecutorType) => void;
  loading: boolean;
  onClose: () => void;
  mcpTools: McpTool[];
  onAddMcp: (url: string, name?: string) => Promise<void>;
  onRemoveMcp: (serverId: string) => Promise<void>;
  onRefreshMcpTools: () => void;
  mcpLoading: boolean;
}) {
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [addingMcp, setAddingMcp] = useState(false);

  const handleAddMcp = async () => {
    if (!mcpUrl.trim()) return;
    setAddingMcp(true);
    try {
      await onAddMcp(mcpUrl.trim(), mcpName.trim() || undefined);
      setMcpUrl("");
      setMcpName("");
    } finally {
      setAddingMcp(false);
    }
  };

  // Group MCP tools by server
  const toolsByServer = mcpTools.reduce(
    (acc, tool) => {
      if (!acc[tool.serverId]) acc[tool.serverId] = [];
      acc[tool.serverId].push(tool);
      return acc;
    },
    {} as Record<string, McpTool[]>
  );

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
        onClick={onClose}
        aria-label="Close settings"
      />
      <aside className="fixed top-0 right-0 bottom-0 w-[400px] max-w-[90vw] bg-kumo-base border-l border-kumo-line z-50 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-kumo-line bg-gradient-to-r from-kumo-base to-kumo-elevated">
          <Text variant="heading3">Settings</Text>
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            icon={<XIcon size={16} />}
            onClick={onClose}
            aria-label="Close"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {/* Executor Section */}
          <div>
            <span className="text-xs font-semibold text-kumo-secondary mb-2 block uppercase tracking-wider">
              Executor
            </span>
            <select
              className="w-full px-3 py-2 bg-kumo-elevated border border-kumo-line rounded-lg text-kumo-default text-sm outline-none focus:ring-2 focus:ring-kumo-ring transition-all"
              value={executor}
              onChange={(e) => onExecutorChange(e.target.value as ExecutorType)}
              disabled={loading}
            >
              {EXECUTORS.map((exec) => (
                <option key={exec.value} value={exec.value}>
                  {exec.label}
                </option>
              ))}
            </select>
            <div className="mt-1">
              <Text size="xs" variant="secondary">
                {EXECUTORS.find((e) => e.value === executor)?.description}
              </Text>
            </div>
          </div>

          {/* MCP Servers Section */}
          <div className="relative">
            <div className="absolute -inset-3 bg-gradient-to-br from-orange-500/5 via-transparent to-amber-500/5 rounded-2xl -z-10" />
            <div className="flex items-center gap-2 mb-3">
              <PlugsConnectedIcon
                size={16}
                className="text-orange-500"
                weight="duotone"
              />
              <span className="text-xs font-semibold text-kumo-secondary uppercase tracking-wider">
                MCP Servers
              </span>
            </div>

            <div className="space-y-3 p-3 bg-kumo-elevated/50 rounded-xl border border-kumo-line">
              <div className="space-y-2">
                <input
                  type="text"
                  value={mcpUrl}
                  onChange={(e) => setMcpUrl(e.target.value)}
                  placeholder="https://docs.mcp.cloudflare.com/mcp"
                  className="w-full px-3 py-2.5 bg-kumo-base border border-kumo-line rounded-lg text-kumo-default text-sm outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500/50 transition-all placeholder:text-kumo-inactive"
                  disabled={addingMcp}
                />
                <input
                  type="text"
                  value={mcpName}
                  onChange={(e) => setMcpName(e.target.value)}
                  placeholder="Server name (optional)"
                  className="w-full px-3 py-2 bg-kumo-base border border-kumo-line rounded-lg text-kumo-default text-xs outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500/50 transition-all placeholder:text-kumo-inactive"
                  disabled={addingMcp}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleAddMcp}
                  disabled={!mcpUrl.trim() || addingMcp}
                  loading={addingMcp}
                  icon={<PlusIcon size={14} />}
                  className="w-full !bg-gradient-to-r !from-orange-500/10 !to-amber-500/10 hover:!from-orange-500/20 hover:!to-amber-500/20 !border-orange-500/30"
                >
                  Connect MCP Server
                </Button>
              </div>

              {Object.keys(toolsByServer).length > 0 && (
                <div className="pt-3 border-t border-kumo-line space-y-3">
                  <div className="flex items-center justify-between">
                    <Text size="xs" variant="secondary" bold>
                      Connected Servers
                    </Text>
                    <button
                      type="button"
                      onClick={onRefreshMcpTools}
                      disabled={mcpLoading}
                      className="text-xs text-kumo-secondary hover:text-kumo-default transition-colors flex items-center gap-1"
                    >
                      {mcpLoading ? (
                        <SpinnerGapIcon size={12} className="animate-spin" />
                      ) : (
                        "Refresh"
                      )}
                    </button>
                  </div>
                  {Object.entries(toolsByServer).map(([serverId, tools]) => (
                    <div
                      key={serverId}
                      className="bg-kumo-base rounded-lg border border-kumo-line overflow-hidden"
                    >
                      <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-orange-500/10 to-transparent border-b border-kumo-line">
                        <CubeIcon
                          size={14}
                          className="text-orange-500"
                          weight="duotone"
                        />
                        <span className="truncate flex-1">
                          <Text size="xs" bold>
                            {serverId}
                          </Text>
                        </span>
                        <Badge variant="secondary" className="text-[10px]">
                          {tools.length} tools
                        </Badge>
                        <button
                          type="button"
                          onClick={() => onRemoveMcp(serverId)}
                          className="p-1 text-kumo-inactive hover:text-red-500 transition-colors"
                          title="Remove server"
                        >
                          <XIcon size={12} />
                        </button>
                      </div>
                      <div className="divide-y divide-kumo-line max-h-32 overflow-y-auto">
                        {tools.map((tool) => (
                          <div
                            key={`${tool.serverId}-${tool.name}`}
                            className="px-3 py-1.5 hover:bg-kumo-elevated transition-colors"
                          >
                            <span className="text-[11px] font-mono text-orange-400/90 block">
                              {tool.name}
                            </span>
                            {tool.description && (
                              <span className="text-[10px] text-kumo-secondary line-clamp-1">
                                {tool.description}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {Object.keys(toolsByServer).length === 0 && (
                <div className="text-center py-4">
                  <PlugsConnectedIcon
                    size={24}
                    className="text-kumo-inactive mx-auto mb-2"
                  />
                  <Text size="xs" variant="secondary">
                    No MCP servers connected
                  </Text>
                </div>
              )}
            </div>
          </div>

          {/* Available Functions Section */}
          <div>
            <span className="text-xs font-semibold text-kumo-secondary mb-2 block uppercase tracking-wider">
              Built-in Functions
            </span>
            <div className="border border-kumo-line rounded-lg overflow-hidden divide-y divide-kumo-line">
              {TOOLS.map((tool) => (
                <div
                  key={tool.name}
                  className="flex items-baseline gap-3 px-3 py-2 bg-kumo-elevated hover:bg-kumo-base transition-colors"
                >
                  <span className="text-xs font-semibold font-mono text-kumo-brand shrink-0">
                    {tool.name}
                  </span>
                  <span className="text-xs text-kumo-secondary truncate">
                    {tool.description}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

function App() {
  const [input, setInput] = useState("");
  const [executor, setExecutor] = useState<ExecutorType>("dynamic-worker");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [mcpTools, setMcpTools] = useState<McpTool[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "codemode",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(() => setConnectionStatus("disconnected"), [])
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming";
  const isConnected = connectionStatus === "connected";

  const handleExecutorChange = useCallback(
    (newExecutor: ExecutorType) => {
      setExecutor(newExecutor);
      agent.call("setExecutor", [newExecutor]);
    },
    [agent]
  );

  const refreshMcpTools = useCallback(async () => {
    setMcpLoading(true);
    try {
      const tools = await agent.call("listMcpTools", []);
      setMcpTools(tools as McpTool[]);
    } catch (err) {
      console.error("Failed to list MCP tools:", err);
    } finally {
      setMcpLoading(false);
    }
  }, [agent]);

  const handleAddMcp = useCallback(
    async (url: string, name?: string) => {
      try {
        await agent.call("addMcp", [url, name]);
        // Refresh tools list after adding server
        await refreshMcpTools();
      } catch (err) {
        console.error("Failed to add MCP server:", err);
        throw err;
      }
    },
    [agent, refreshMcpTools]
  );

  const handleRemoveMcp = useCallback(
    async (serverId: string) => {
      try {
        await agent.call("removeMcp", [serverId]);
        await refreshMcpTools();
      } catch (err) {
        console.error("Failed to remove MCP server:", err);
      }
    },
    [agent, refreshMcpTools]
  );

  // Load MCP tools when settings panel opens
  useEffect(() => {
    if (settingsOpen && isConnected) {
      refreshMcpTools();
    }
  }, [settingsOpen, isConnected, refreshMcpTools]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Codemode
            </h1>
            <Badge variant="secondary">
              <LightningIcon size={12} weight="bold" className="mr-1" />
              {EXECUTORS.find((e) => e.value === executor)?.label}
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              icon={<GearIcon size={16} />}
              onClick={() => setSettingsOpen(!settingsOpen)}
              aria-label="Settings"
            />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
              disabled={messages.length === 0}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<LightningIcon size={32} />}
              title="Welcome to Codemode"
              description="AI-powered project management. Ask me to create projects, manage tasks, plan sprints, and more."
            />
          )}

          {messages.map((message, msgIndex) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && msgIndex === messages.length - 1;
            const isAnimating = isStreaming && isLastAssistant;

            if (isUser) {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse">
                    <Streamdown
                      className="sd-theme px-4 py-2.5 text-sm leading-relaxed **:text-kumo-inverse"
                      controls={false}
                    >
                      {message.parts
                        .filter((p) => p.type === "text")
                        .map((p) => (p.type === "text" ? p.text : ""))
                        .join("")}
                    </Streamdown>
                  </div>
                </div>
              );
            }

            return (
              <div key={message.id} className="space-y-2">
                {message.parts.map((part, partIdx) => {
                  if (part.type === "text") {
                    if (!part.text || part.text.trim() === "") return null;
                    return (
                      <div key={partIdx} className="flex justify-start">
                        <Surface className="max-w-[80%] rounded-2xl rounded-bl-md ring ring-kumo-line">
                          <Streamdown
                            className="sd-theme px-4 py-2.5 text-sm leading-relaxed"
                            controls={false}
                            isAnimating={isAnimating}
                          >
                            {part.text}
                          </Streamdown>
                        </Surface>
                      </div>
                    );
                  }

                  if (part.type === "step-start") return null;

                  if (part.type === "reasoning") {
                    return (
                      <ReasoningBlock
                        key={partIdx}
                        text={part.text}
                        isStreaming={isAnimating}
                      />
                    );
                  }

                  if (isToolUIPart(part)) {
                    const toolPart = part as unknown as ToolPart;
                    return (
                      <div
                        key={toolPart.toolCallId ?? partIdx}
                        className="max-w-[80%]"
                      >
                        <ToolCard toolPart={toolPart} />
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
                isConnected
                  ? "Ask me to manage your projects..."
                  : "Connecting..."
              }
              disabled={!isConnected || isStreaming}
              rows={2}
              className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
            />
            <Button
              type="submit"
              variant="primary"
              shape="square"
              size="sm"
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

      {settingsOpen && (
        <SettingsPanel
          executor={executor}
          onExecutorChange={handleExecutorChange}
          loading={isStreaming}
          onClose={() => setSettingsOpen(false)}
          mcpTools={mcpTools}
          onAddMcp={handleAddMcp}
          onRemoveMcp={handleRemoveMcp}
          onRefreshMcpTools={refreshMcpTools}
          mcpLoading={mcpLoading}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
