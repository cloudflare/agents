import { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@cloudflare/agents-ui/hooks";
import {
  ConnectionIndicator,
  ModeToggle,
  PoweredByAgents,
  type ConnectionStatus
} from "@cloudflare/agents-ui";
import { Button, Badge, Surface, Text, Empty } from "@cloudflare/kumo";
import {
  WrenchIcon,
  DatabaseIcon,
  PaperPlaneRightIcon,
  TrashIcon,
  ArrowClockwiseIcon,
  PlugIcon,
  InfoIcon,
  WarningCircleIcon,
  CheckCircleIcon
} from "@phosphor-icons/react";
import "./styles.css";

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

interface McpResource {
  name: string;
  uri: string;
  description?: string;
}

interface ServerInfo {
  name: string;
  version: string;
}

interface ToolResult {
  label: string;
  text: string;
  isError: boolean;
  timestamp: number;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let nextId = 0;

async function mcpFetch(
  endpoint: string,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | null
): Promise<{ data: JsonRpcResponse | null; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  const isNotification = method.startsWith("notifications/");
  if (!isNotification) body.id = ++nextId;

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const newSessionId = res.headers.get("mcp-session-id") || sessionId;

  if (isNotification || res.status === 202) {
    return { data: null, sessionId: newSessionId };
  }

  const contentType = res.headers.get("content-type") || "";
  let data: JsonRpcResponse;
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const match = text.match(/^data: (.+)$/m);
    data = match ? JSON.parse(match[1]) : { jsonrpc: "2.0" };
  } else {
    data = await res.json();
  }

  return { data, sessionId: newSessionId };
}

function ToolCard({
  tool,
  onCall
}: {
  tool: McpTool;
  onCall: (name: string, args: Record<string, unknown>) => Promise<void>;
}) {
  const [args, setArgs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const properties = tool.inputSchema?.properties || {};
  const propertyEntries = Object.entries(properties);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const typedArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      const prop = properties[key];
      if (prop?.type === "number" || prop?.type === "integer") {
        typedArgs[key] = Number(value);
      } else if (prop?.type === "boolean") {
        typedArgs[key] = value === "true";
      } else {
        typedArgs[key] = value;
      }
    }

    await onCall(tool.name, typedArgs);
    setLoading(false);
  };

  return (
    <Surface className="p-4 rounded-xl ring ring-kumo-line">
      <Text size="sm" bold>
        {tool.name}
      </Text>
      {tool.description && (
        <span className="mt-0.5 block">
          <Text size="xs" variant="secondary">
            {tool.description}
          </Text>
        </span>
      )}
      <form onSubmit={handleSubmit} className="mt-3 space-y-2">
        {propertyEntries.map(([key, schema]) => (
          <div key={key}>
            <label className="block text-xs text-kumo-subtle mb-1">
              {key}
              {tool.inputSchema?.required?.includes(key) && (
                <span className="text-red-500"> *</span>
              )}
              <input
                type={
                  schema.type === "number" || schema.type === "integer"
                    ? "number"
                    : "text"
                }
                value={args[key] || ""}
                onChange={(e) =>
                  setArgs((prev) => ({
                    ...prev,
                    [key]: e.target.value
                  }))
                }
                placeholder={schema.description || key}
                className="mt-1 w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
              />
            </label>
          </div>
        ))}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={loading}
          icon={<PaperPlaneRightIcon size={14} />}
        >
          Call
        </Button>
      </form>
    </Surface>
  );
}

function App() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [resources, setResources] = useState<McpResource[]>([]);
  const [results, setResults] = useState<ToolResult[]>([]);
  const sessionRef = useRef<string | null>(null);

  const connect = useCallback(async () => {
    try {
      setStatus("connecting");

      const init = await mcpFetch(
        "/mcp",
        "initialize",
        {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "browser-tester",
            version: "1.0.0"
          }
        },
        null
      );

      sessionRef.current = init.sessionId;
      const initResult = init.data?.result as
        | { serverInfo?: ServerInfo }
        | undefined;
      setServerInfo(initResult?.serverInfo ?? null);

      await mcpFetch("/mcp", "notifications/initialized", {}, init.sessionId);

      const toolsRes = await mcpFetch("/mcp", "tools/list", {}, init.sessionId);
      const toolsResult = toolsRes.data?.result as
        | { tools?: McpTool[] }
        | undefined;
      setTools(toolsResult?.tools ?? []);

      try {
        const resourcesRes = await mcpFetch(
          "/mcp",
          "resources/list",
          {},
          init.sessionId
        );
        const resourcesResult = resourcesRes.data?.result as
          | { resources?: McpResource[] }
          | undefined;
        setResources(resourcesResult?.resources ?? []);
      } catch {
        // Server may not support resources
      }

      setStatus("connected");
    } catch {
      setStatus("disconnected");
    }
  }, []);

  useEffect(() => {
    connect();
  }, [connect]);

  const handleCallTool = async (
    name: string,
    args: Record<string, unknown>
  ) => {
    try {
      const res = await mcpFetch(
        "/mcp",
        "tools/call",
        { name, arguments: args },
        sessionRef.current
      );
      const result = res.data?.result as
        | {
            content?: Array<{ type: string; text?: string }>;
            isError?: boolean;
          }
        | undefined;
      const text = result?.content?.[0]?.text ?? JSON.stringify(result);
      setResults((prev) => [
        {
          label: name,
          text,
          isError: result?.isError ?? false,
          timestamp: Date.now()
        },
        ...prev
      ]);
    } catch (err) {
      setResults((prev) => [
        {
          label: name,
          text: err instanceof Error ? err.message : String(err),
          isError: true,
          timestamp: Date.now()
        },
        ...prev
      ]);
    }
  };

  const handleReadResource = async (uri: string) => {
    try {
      const res = await mcpFetch(
        "/mcp",
        "resources/read",
        { uri },
        sessionRef.current
      );
      const result = res.data?.result as
        | { contents?: Array<{ text?: string; uri?: string }> }
        | undefined;
      const text = result?.contents?.[0]?.text ?? JSON.stringify(result);
      setResults((prev) => [
        { label: uri, text, isError: false, timestamp: Date.now() },
        ...prev
      ]);
    } catch (err) {
      setResults((prev) => [
        {
          label: uri,
          text: err instanceof Error ? err.message : String(err),
          isError: true,
          timestamp: Date.now()
        },
        ...prev
      ]);
    }
  };

  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <PlugIcon size={22} className="text-kumo-accent" weight="bold" />
            <h1 className="text-lg font-semibold text-kumo-default">
              {serverInfo?.name ?? "MCP Server"}
            </h1>
            {serverInfo && (
              <Badge variant="secondary">v{serverInfo.version}</Badge>
            )}
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={status} />
            <ModeToggle />
            {status === "disconnected" && (
              <Button
                variant="secondary"
                size="sm"
                icon={<ArrowClockwiseIcon size={14} />}
                onClick={connect}
              >
                Reconnect
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-3xl mx-auto space-y-8">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  Stateless MCP Server (createMcpHandler)
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    The simplest way to run an MCP server on Cloudflare Workers.
                    Uses{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      createMcpHandler
                    </code>{" "}
                    from the Agents SDK to wrap an{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      McpServer
                    </code>{" "}
                    into a Worker-compatible fetch handler in one line — no
                    Durable Objects, no persistent state.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {status === "disconnected" && (
            <Empty
              icon={<PlugIcon size={32} />}
              title="Disconnected"
              description="Could not connect to the MCP server. Make sure it is running and try reconnecting."
            />
          )}

          {status === "connected" && (
            <>
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <WrenchIcon
                    size={18}
                    weight="bold"
                    className="text-kumo-subtle"
                  />
                  <Text size="base" bold>
                    Tools
                  </Text>
                  <Badge variant="secondary">{tools.length}</Badge>
                </div>
                {tools.length === 0 ? (
                  <Empty
                    icon={<WrenchIcon size={32} />}
                    title="No tools"
                    description="This server has no registered tools."
                  />
                ) : (
                  <div className="space-y-3">
                    {tools.map((tool) => (
                      <ToolCard
                        key={tool.name}
                        tool={tool}
                        onCall={handleCallTool}
                      />
                    ))}
                  </div>
                )}
              </section>

              {resources.length > 0 && (
                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <DatabaseIcon
                      size={18}
                      weight="bold"
                      className="text-kumo-subtle"
                    />
                    <Text size="base" bold>
                      Resources
                    </Text>
                    <Badge variant="secondary">{resources.length}</Badge>
                  </div>
                  <div className="space-y-2">
                    {resources.map((r) => (
                      <Surface
                        key={r.uri}
                        className="p-3 rounded-xl ring ring-kumo-line flex items-center justify-between"
                      >
                        <div>
                          <Text size="sm" bold>
                            {r.name}
                          </Text>
                          <Text size="xs" variant="secondary">
                            {r.uri}
                          </Text>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleReadResource(r.uri)}
                        >
                          Read
                        </Button>
                      </Surface>
                    ))}
                  </div>
                </section>
              )}

              {results.length > 0 && (
                <section>
                  <div className="flex items-center justify-between mb-3">
                    <Text size="base" bold>
                      Results
                    </Text>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<TrashIcon size={14} />}
                      onClick={() => setResults([])}
                    >
                      Clear
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {results.map((r) => (
                      <Surface
                        key={r.timestamp}
                        className={`p-3 rounded-xl ring ${r.isError ? "ring-red-500/30 bg-red-50 dark:bg-red-950/20" : "ring-kumo-line"}`}
                      >
                        <div className="flex items-start gap-2">
                          {r.isError ? (
                            <WarningCircleIcon
                              size={16}
                              weight="fill"
                              className="text-red-500 shrink-0 mt-0.5"
                            />
                          ) : (
                            <CheckCircleIcon
                              size={16}
                              weight="fill"
                              className="text-green-600 shrink-0 mt-0.5"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <Text size="xs" variant="secondary" bold>
                              {r.label}
                            </Text>
                            <p
                              className={`text-sm mt-0.5 whitespace-pre-wrap break-words ${r.isError ? "text-red-600 dark:text-red-400" : "text-kumo-default"}`}
                            >
                              {r.text}
                            </p>
                          </div>
                          <span className="text-[10px] text-kumo-inactive tabular-nums shrink-0">
                            {new Date(r.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                      </Surface>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </main>

      <footer className="border-t border-kumo-line py-3">
        <div className="flex justify-center">
          <PoweredByAgents />
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
