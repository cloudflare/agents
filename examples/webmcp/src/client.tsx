import { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  Badge,
  Surface,
  Text,
  Empty,
  PoweredByCloudflare
} from "@cloudflare/kumo";
import {
  GlobeIcon,
  WrenchIcon,
  InfoIcon,
  CheckCircleIcon,
  WarningCircleIcon,
  ArrowClockwiseIcon,
  MoonIcon,
  SunIcon,
  PlayIcon,
  PlugsIcon,
  PlugsConnectedIcon
} from "@phosphor-icons/react";
import { registerWebMcp, type WebMcpHandle } from "agents/experimental/webmcp";
import "./styles.css";

// ── Types ────────────────────────────────────────────────────────────

type ToolSource = "page" | "remote";

interface RegisteredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  source: ToolSource;
  /**
   * Direct invoke handle. Available for in-page tools (we own the execute);
   * undefined for remote tools (their execute lives inside the adapter and
   * is meant to be called by the browser AI).
   */
  invoke?: (args: Record<string, unknown>) => Promise<string>;
}

type ConnectionStatus = "disconnected" | "connecting" | "connected";

type LogLevel = "info" | "warn" | "error";
interface LogEntry {
  id: number;
  message: string;
  level: LogLevel;
  timestamp: number;
}

// ── Constants ────────────────────────────────────────────────────────

const REMOTE_PREFIX = "remote.";
const hasWebMcp = typeof navigator !== "undefined" && !!navigator.modelContext;

// ── In-page tools ────────────────────────────────────────────────────
// These run entirely in the page — they can touch the DOM, read local
// state, etc. They live alongside the bridged remote tools in the same
// navigator.modelContext registry.

interface InPageToolDef {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

function getInPageTools(setTheme: (mode: string) => void): InPageToolDef[] {
  return [
    {
      name: "page.scroll_to_top",
      description: "Scroll the demo page back to the top",
      execute: async () => {
        window.scrollTo({ top: 0, behavior: "smooth" });
        return "Scrolled to top";
      }
    },
    {
      name: "page.set_theme",
      description: "Switch the page between light and dark mode",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["light", "dark"] }
        },
        required: ["mode"]
      },
      execute: async (args) => {
        const mode = args.mode === "dark" ? "dark" : "light";
        setTheme(mode);
        return `Theme set to ${mode}`;
      }
    },
    {
      name: "page.get_url",
      description: "Read the current page URL",
      execute: async () => window.location.href
    }
  ];
}

function registerInPageTools(
  tools: InPageToolDef[]
): { name: string; controller: AbortController }[] {
  if (!navigator.modelContext) return [];
  const registered: { name: string; controller: AbortController }[] = [];
  for (const tool of tools) {
    const controller = new AbortController();
    navigator.modelContext.registerTool(
      {
        name: tool.name,
        description: tool.description,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        execute: async (input) => tool.execute(input)
      },
      { signal: controller.signal }
    );
    registered.push({ name: tool.name, controller });
  }
  return registered;
}

// ── UI bits ──────────────────────────────────────────────────────────

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
        ? "Connecting…"
        : "Disconnected";
  return (
    <output className="flex items-center gap-2">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className={`text-xs ${text}`}>{label}</span>
    </output>
  );
}

function ModeToggle({
  mode,
  setMode
}: {
  mode: string;
  setMode: (m: string) => void;
}) {
  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode(mode === "light" ? "dark" : "light")}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

interface ToolInputFormProps {
  schema: Record<string, unknown> | undefined;
  onSubmit: (args: Record<string, unknown>) => void;
}

function ToolInputForm({ schema, onSubmit }: ToolInputFormProps) {
  const properties =
    (schema?.properties as
      | Record<string, { type?: string; description?: string }>
      | undefined) ?? {};
  const required =
    (schema?.required as string[] | undefined) ?? Object.keys(properties);
  const propertyEntries = Object.entries(properties);
  const [values, setValues] = useState<Record<string, string>>({});

  if (propertyEntries.length === 0) {
    return (
      <Button
        size="sm"
        variant="primary"
        icon={<PlayIcon size={14} weight="fill" />}
        onClick={() => onSubmit({})}
      >
        Invoke
      </Button>
    );
  }

  const submit = () => {
    const args: Record<string, unknown> = {};
    for (const [key, prop] of propertyEntries) {
      const raw = values[key] ?? "";
      if (prop.type === "number") {
        const n = Number(raw);
        args[key] = Number.isFinite(n) ? n : 0;
      } else if (prop.type === "boolean") {
        args[key] = raw === "true";
      } else {
        args[key] = raw;
      }
    }
    onSubmit(args);
  };

  return (
    <div className="space-y-2">
      {propertyEntries.map(([key, prop]) => (
        <label
          key={key}
          className="flex flex-col gap-1 text-xs text-kumo-default"
        >
          <span className="flex items-center gap-2">
            <span className="font-mono">{key}</span>
            <span className="text-kumo-subtle">{prop.type ?? "string"}</span>
            {required.includes(key) && (
              <span className="text-orange-500 text-[10px]">required</span>
            )}
          </span>
          <input
            type={prop.type === "number" ? "number" : "text"}
            value={values[key] ?? ""}
            onChange={(e) =>
              setValues((v) => ({ ...v, [key]: e.target.value }))
            }
            className="px-2 py-1 rounded ring ring-kumo-line bg-kumo-base text-xs"
            placeholder={prop.description ?? ""}
          />
        </label>
      ))}
      <Button
        size="sm"
        variant="primary"
        icon={<PlayIcon size={14} weight="fill" />}
        onClick={submit}
      >
        Invoke
      </Button>
    </div>
  );
}

function ToolCard({
  tool,
  onInvoke
}: {
  tool: RegisteredTool;
  onInvoke: (tool: RegisteredTool, args: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Surface className="p-4 rounded-xl ring ring-kumo-line">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <CheckCircleIcon
            size={16}
            weight="fill"
            className="text-green-600 shrink-0"
          />
          <Text size="sm" bold>
            {tool.name}
          </Text>
          <Badge variant={tool.source === "page" ? "secondary" : "success"}>
            {tool.source}
          </Badge>
        </div>
        {tool.invoke ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOpen((v) => !v)}
            icon={<PlayIcon size={14} />}
          >
            {open ? "Hide" : "Invoke"}
          </Button>
        ) : (
          <span className="text-[10px] text-kumo-subtle">
            invoke from Chrome AI
          </span>
        )}
      </div>
      {tool.description && (
        <span className="mt-0.5 block">
          <Text size="xs" variant="secondary">
            {tool.description}
          </Text>
        </span>
      )}
      {open && tool.invoke && (
        <div className="mt-3 pt-3 border-t border-kumo-line">
          <ToolInputForm
            schema={tool.inputSchema}
            onSubmit={(args) => {
              setOpen(false);
              onInvoke(tool, args);
            }}
          />
        </div>
      )}
    </Surface>
  );
}

// ── App ──────────────────────────────────────────────────────────────

function App() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  const [mcpStatus, setMcpStatus] = useState<ConnectionStatus>("disconnected");
  const [pageTools, setPageTools] = useState<RegisteredTool[]>([]);
  const [remoteTools, setRemoteTools] = useState<RegisteredTool[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const handleRef = useRef<WebMcpHandle | null>(null);
  const pageToolControllersRef = useRef<
    { name: string; controller: AbortController }[]
  >([]);
  const logIdRef = useRef(0);

  const addLog = useCallback((message: string, level: LogLevel = "info") => {
    setLogs((prev) => [
      { id: ++logIdRef.current, message, level, timestamp: Date.now() },
      ...prev.slice(0, 49)
    ]);
  }, []);

  // Register in-page tools once on mount. They live in
  // navigator.modelContext alongside whatever the WebMCP adapter
  // registers, so the browser AI sees both.
  useEffect(() => {
    if (!hasWebMcp) return;
    const tools = getInPageTools(setMode);
    const registered = registerInPageTools(tools);
    pageToolControllersRef.current = registered;
    setPageTools(
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        source: "page" as const,
        invoke: t.execute
      }))
    );
    addLog(`Registered ${tools.length} in-page tool(s)`);
    return () => {
      for (const { controller } of pageToolControllersRef.current) {
        controller.abort();
      }
      pageToolControllersRef.current = [];
    };
  }, [addLog]);

  const connect = useCallback(async () => {
    if (handleRef.current && !handleRef.current.disposed) {
      addLog("Already connected", "warn");
      return;
    }
    setMcpStatus("connecting");
    addLog("Initializing WebMCP adapter…");

    if (!hasWebMcp) {
      addLog(
        "navigator.modelContext is not available in this browser. " +
          "To use WebMCP, open this page in Chrome Canary with " +
          "#enable-webmcp-testing and #enable-experimental-web-platform-features " +
          "enabled at chrome://flags.",
        "warn"
      );
    }

    try {
      const h = await registerWebMcp({
        url: "/mcp",
        watch: true,
        prefix: REMOTE_PREFIX,
        onSync: (mcpTools) => {
          const names = mcpTools.map((t) => t.name);
          addLog(
            `Synced ${mcpTools.length} remote tool(s): ${names.join(", ") || "none"}`
          );
          setRemoteTools(
            mcpTools.map((t) => ({
              name: `${REMOTE_PREFIX}${t.name}`,
              description: t.description,
              inputSchema: t.inputSchema,
              source: "remote" as const
            }))
          );
        },
        onError: (err) => {
          addLog(`Sync error: ${err.message}`, "error");
        }
      });

      handleRef.current = h;

      if (!hasWebMcp) {
        setMcpStatus("disconnected");
        addLog(
          "Adapter running in no-op mode (navigator.modelContext unavailable).",
          "warn"
        );
      } else {
        setMcpStatus("connected");
        addLog(`WebMCP active — ${h.tools.length} remote tool(s) registered`);
      }
    } catch (err) {
      setMcpStatus("disconnected");
      addLog(
        `Failed to connect to MCP server: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    }
  }, [addLog]);

  const disconnect = useCallback(async () => {
    if (!handleRef.current) return;
    addLog("Disconnecting…");
    await handleRef.current.dispose();
    handleRef.current = null;
    setRemoteTools([]);
    setMcpStatus("disconnected");
    addLog("Disconnected from MCP server");
  }, [addLog]);

  // Auto-connect on mount (only if WebMCP is available — otherwise
  // wait for the user to click the connect button after they've
  // followed the Chrome flag instructions).
  useEffect(() => {
    if (hasWebMcp) {
      connect();
    }
    return () => {
      handleRef.current?.dispose();
    };
  }, [connect]);

  const refresh = useCallback(async () => {
    if (!handleRef.current) {
      await connect();
      return;
    }
    addLog("Refreshing remote tools…");
    await handleRef.current.refresh();
  }, [addLog, connect]);

  const invokeTool = useCallback(
    async (tool: RegisteredTool, args: Record<string, unknown>) => {
      if (!tool.invoke) {
        addLog(`No direct-invoke for "${tool.name}"`, "warn");
        return;
      }
      addLog(`→ ${tool.name}(${JSON.stringify(args)})`);
      try {
        const result = await tool.invoke(args);
        addLog(`← ${tool.name}: ${result}`);
      } catch (err) {
        addLog(
          `✗ ${tool.name}: ${err instanceof Error ? err.message : String(err)}`,
          "error"
        );
      }
    },
    [addLog]
  );

  const allTools = [...pageTools, ...remoteTools];

  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <GlobeIcon size={22} className="text-kumo-accent" weight="bold" />
            <h1 className="text-lg font-semibold text-kumo-default">
              WebMCP Adapter
            </h1>
            <Badge variant="secondary">experimental</Badge>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={mcpStatus} />
            <ModeToggle mode={mode} setMode={setMode} />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-3xl mx-auto space-y-6">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  In-page tools + bridged remote tools
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    This demo registers a few page-local tools (DOM interactions
                    like scrolling and theme switching) and uses{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      registerWebMcp()
                    </code>{" "}
                    to bridge an{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      McpAgent
                    </code>{" "}
                    server's tools (counter and greet) into the same{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      navigator.modelContext
                    </code>{" "}
                    registry. Chrome's AI agent — or the{" "}
                    <a
                      href="https://chromewebstore.google.com/detail/web-mcp/lmhcjoefoeigdnpmiamglmkggbnjlicl"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-kumo-accent underline underline-offset-2"
                    >
                      WebMCP Chrome extension
                    </a>{" "}
                    — sees both kinds of tools side by side. Use the Invoke
                    button on in-page tools to test them from the page directly.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {!hasWebMcp && (
            <Surface className="p-4 rounded-xl ring ring-yellow-500/30">
              <div className="flex gap-3">
                <WarningCircleIcon
                  size={20}
                  weight="bold"
                  className="text-yellow-500 shrink-0 mt-0.5"
                />
                <div>
                  <Text size="sm" bold>
                    navigator.modelContext not available
                  </Text>
                  <span className="mt-1 block">
                    <Text size="xs" variant="secondary">
                      Chrome's WebMCP API is not available in this browser. The
                      adapter is a no-op and no tools can be registered with the
                      browser's AI agent. To enable WebMCP, use Chrome Canary
                      with the{" "}
                      <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                        #enable-webmcp-testing
                      </code>{" "}
                      and{" "}
                      <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                        #enable-experimental-web-platform-features
                      </code>{" "}
                      flags at{" "}
                      <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                        chrome://flags
                      </code>
                      .
                    </Text>
                  </span>
                </div>
              </div>
            </Surface>
          )}

          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <WrenchIcon
                  size={18}
                  weight="bold"
                  className="text-kumo-subtle"
                />
                <Text size="base" bold>
                  Registered Tools
                </Text>
                <Badge variant="secondary">{allTools.length}</Badge>
              </div>
              <div className="flex items-center gap-2">
                {mcpStatus === "connected" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<PlugsIcon size={14} />}
                    onClick={disconnect}
                  >
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<PlugsConnectedIcon size={14} />}
                    onClick={connect}
                    disabled={mcpStatus === "connecting"}
                  >
                    {mcpStatus === "connecting" ? "Connecting…" : "Connect"}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<ArrowClockwiseIcon size={14} />}
                  onClick={refresh}
                  disabled={mcpStatus !== "connected"}
                >
                  Refresh
                </Button>
              </div>
            </div>
            {allTools.length === 0 ? (
              <Empty
                icon={<WrenchIcon size={32} />}
                title="No tools registered"
                description="Connect to the MCP server or enable WebMCP to see registered tools."
              />
            ) : (
              <div className="space-y-3">
                {allTools.map((tool) => (
                  <ToolCard key={tool.name} tool={tool} onInvoke={invokeTool} />
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between mb-3">
              <Text size="base" bold>
                Activity Log
              </Text>
              {logs.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setLogs([])}>
                  Clear
                </Button>
              )}
            </div>
            {logs.length === 0 ? (
              <Empty
                icon={<InfoIcon size={32} />}
                title="No activity"
                description="Events will appear here as the adapter runs."
              />
            ) : (
              <div className="space-y-1">
                {logs.map((log) => (
                  <div
                    key={log.id}
                    className={`flex items-start gap-2 py-1.5 px-3 rounded-lg text-xs ${
                      log.level === "error"
                        ? "bg-red-500/5"
                        : log.level === "warn"
                          ? "bg-yellow-500/5"
                          : ""
                    }`}
                  >
                    {log.level === "error" ? (
                      <WarningCircleIcon
                        size={14}
                        weight="fill"
                        className="text-red-500 shrink-0 mt-0.5"
                      />
                    ) : log.level === "warn" ? (
                      <WarningCircleIcon
                        size={14}
                        weight="fill"
                        className="text-yellow-500 shrink-0 mt-0.5"
                      />
                    ) : (
                      <CheckCircleIcon
                        size={14}
                        weight="fill"
                        className="text-green-600 shrink-0 mt-0.5"
                      />
                    )}
                    <span
                      className={`flex-1 font-mono ${
                        log.level === "error"
                          ? "text-red-600"
                          : log.level === "warn"
                            ? "text-yellow-600"
                            : "text-kumo-default"
                      }`}
                    >
                      {log.message}
                    </span>
                    <span className="text-[10px] text-kumo-inactive tabular-nums shrink-0">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <Text size="sm" bold>
              How it works
            </Text>
            <pre className="mt-2 p-3 rounded-lg bg-kumo-elevated text-xs text-kumo-default overflow-x-auto font-mono whitespace-pre-wrap">
              {`// 1. Register in-page tools — things only the page can do
navigator.modelContext.registerTool({
  name: "page.scroll_to_top",
  description: "Scroll the demo page back to the top",
  execute: async () => { window.scrollTo({ top: 0 }); return "ok"; }
});

// 2. Bridge remote tools — discovered from your McpAgent over /mcp
const handle = await registerWebMcp({
  url: "/mcp",
  prefix: "remote.",     // namespace the bridged names
});

// Both kinds of tools now live in the same navigator.modelContext
// registry. The browser AI sees them as one toolbox.

// To clean up:
await handle.dispose();`}
            </pre>
          </Surface>
        </div>
      </main>

      <footer className="border-t border-kumo-line py-3">
        <div className="flex justify-center">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
