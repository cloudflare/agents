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
  SunIcon
} from "@phosphor-icons/react";
import { registerWebMcp, type WebMcpHandle } from "agents/experimental/webmcp";
import "./styles.css";

interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

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

const hasWebMcp = typeof navigator !== "undefined" && !!navigator.modelContext;

function App() {
  const [mcpStatus, setMcpStatus] = useState<ConnectionStatus>("connecting");
  const [tools, setTools] = useState<DiscoveredTool[]>([]);
  const handleRef = useRef<WebMcpHandle | null>(null);
  const [logs, setLogs] = useState<
    Array<{
      message: string;
      level: "info" | "error" | "warn";
      timestamp: number;
    }>
  >([]);

  const addLog = useCallback(
    (message: string, level: "info" | "error" | "warn" = "info") => {
      setLogs((prev) => [
        { message, level, timestamp: Date.now() },
        ...prev.slice(0, 49)
      ]);
    },
    []
  );

  const initWebMcp = useCallback(async () => {
    addLog("Initializing WebMCP adapter...");

    if (!hasWebMcp) {
      addLog(
        "navigator.modelContext is not available in this browser. " +
          "To use WebMCP, open this page in Chrome Canary with #enable-webmcp-testing and #enable-experimental-web-platform-features enabled at chrome://flags.",
        "warn"
      );
    }

    try {
      const h = await registerWebMcp({
        url: "/mcp",
        watch: true,
        onSync: (mcpTools) => {
          const names = mcpTools.map((t) => t.name);
          addLog(
            `Discovered ${mcpTools.length} tool(s) from MCP server: ${names.join(", ")}`
          );
          setTools(
            mcpTools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema
            }))
          );
        },
        onError: (err) => {
          addLog(`Error: ${err.message}`, "error");
        }
      });

      handleRef.current = h;
      setMcpStatus("connected");

      if (h.tools.length > 0) {
        addLog(
          `WebMCP active — ${h.tools.length} tool(s) registered with navigator.modelContext`
        );
      } else {
        addLog(
          "MCP connection established. Tools discovered but not registered (navigator.modelContext unavailable).",
          "warn"
        );
      }
    } catch (err) {
      setMcpStatus("disconnected");
      addLog(
        `Failed to connect to MCP server: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    }
  }, [addLog]);

  useEffect(() => {
    initWebMcp();
    return () => {
      handleRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = async () => {
    if (handleRef.current) {
      addLog("Refreshing tools...");
      await handleRef.current.refresh();
    } else {
      await initWebMcp();
    }
  };

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
            <ModeToggle />
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
                  WebMCP Adapter Demo
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    This demo uses{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      registerWebMcp()
                    </code>{" "}
                    from{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      agents/experimental/webmcp
                    </code>{" "}
                    to discover tools from the MCP server and register them with
                    Chrome&rsquo;s native{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      navigator.modelContext
                    </code>{" "}
                    API. Install the{" "}
                    <a
                      href="https://chromewebstore.google.com/detail/web-mcp/lmhcjoefoeigdnpmiamglmkggbnjlicl"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-kumo-accent underline underline-offset-2"
                    >
                      WebMCP Chrome extension
                    </a>{" "}
                    to inspect registered tools and debug tool calls in real
                    time.
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
                      Chrome&rsquo;s WebMCP API is not available in this
                      browser. The adapter is a no-op without this API &mdash;
                      tools cannot be registered with the browser&rsquo;s AI
                      agent. To enable WebMCP, use Chrome Canary with the{" "}
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
                  Discovered Tools
                </Text>
                <Badge variant="secondary">{tools.length}</Badge>
                {hasWebMcp && tools.length > 0 && (
                  <Badge variant="success">registered</Badge>
                )}
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon={<ArrowClockwiseIcon size={14} />}
                onClick={handleRefresh}
              >
                Refresh
              </Button>
            </div>
            {tools.length === 0 ? (
              <Empty
                icon={<WrenchIcon size={32} />}
                title="No tools discovered"
                description="Tools will appear here once the MCP connection is established."
              />
            ) : (
              <div className="space-y-3">
                {tools.map((tool) => {
                  const schema = tool.inputSchema as
                    | {
                        properties?: Record<
                          string,
                          { type?: string; description?: string }
                        >;
                        required?: string[];
                      }
                    | undefined;
                  const properties = schema?.properties ?? {};
                  const propertyEntries = Object.entries(properties);

                  return (
                    <Surface
                      key={tool.name}
                      className="p-4 rounded-xl ring ring-kumo-line"
                    >
                      <div className="flex items-center gap-2">
                        <CheckCircleIcon
                          size={16}
                          weight="fill"
                          className="text-green-600 shrink-0"
                        />
                        <Text size="sm" bold>
                          {tool.name}
                        </Text>
                      </div>
                      {tool.description && (
                        <span className="mt-0.5 block">
                          <Text size="xs" variant="secondary">
                            {tool.description}
                          </Text>
                        </span>
                      )}
                      {propertyEntries.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {propertyEntries.map(([key, propSchema]) => (
                            <div
                              key={key}
                              className="flex items-center gap-2 text-xs text-kumo-subtle"
                            >
                              <span className="font-mono bg-kumo-elevated px-1.5 py-0.5 rounded">
                                {key}
                              </span>
                              <span>{propSchema.type ?? "unknown"}</span>
                              {schema?.required?.includes(key) && (
                                <span className="text-orange-500 text-[10px]">
                                  required
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </Surface>
                  );
                })}
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
                    key={log.timestamp}
                    className="flex items-start gap-2 py-1.5 px-3 rounded-lg text-xs"
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
                      className={`flex-1 ${
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
              {`1. registerWebMcp() connects to your MCP server
2. Discovers tools via tools/list
3. Registers each with navigator.modelContext.registerTool()
4. Chrome's AI agent can now call your tools
5. Calls are relayed back to the MCP server via tools/call`}
            </pre>
            <div className="mt-3">
              <Text size="sm" bold>
                Usage
              </Text>
            </div>
            <pre className="mt-2 p-3 rounded-lg bg-kumo-elevated text-xs text-kumo-default overflow-x-auto font-mono">
              {`import { registerWebMcp } from "agents/experimental/webmcp";

const handle = await registerWebMcp({ url: "/mcp" });
// Tools are now registered with navigator.modelContext`}
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
