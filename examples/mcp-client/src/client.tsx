import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
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
  PlusIcon,
  PlugIcon,
  PlugsConnectedIcon,
  WrenchIcon,
  ChatTextIcon,
  DatabaseIcon,
  TrashIcon,
  SignInIcon,
  InfoIcon,
  PlayIcon,
  MoonIcon,
  SunIcon
} from "@phosphor-icons/react";
import type { MCPServersState } from "agents";
import { nanoid } from "nanoid";
import type { PendingElicitation } from "./server";
import "./styles.css";

let sessionId = localStorage.getItem("sessionId");
if (!sessionId) {
  sessionId = nanoid(8);
  localStorage.setItem("sessionId", sessionId);
}

type ConnectionStatus = "connecting" | "connected" | "disconnected";

type ElicitResponse = {
  action: "accept" | "decline" | "cancel";
  content: Record<string, unknown>;
};

type SchemaProperty = {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
};

/** Form fields generated from a JSON Schema `properties` map. */
function SchemaFields({
  properties,
  values,
  onChange
}: {
  properties: Record<string, SchemaProperty>;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div className="space-y-2">
      {Object.entries(properties).map(([key, prop]) => (
        <label key={key} className="block text-xs text-kumo-subtle">
          {prop.title ?? key}
          {prop.type === "boolean" ? (
            <input
              type="checkbox"
              className="ml-2 align-middle"
              checked={Boolean(values[key] ?? prop.default ?? false)}
              onChange={(e) => onChange(key, e.target.checked)}
            />
          ) : prop.enum ? (
            <select
              className="w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default"
              value={String(values[key] ?? prop.default ?? "")}
              onChange={(e) => onChange(key, e.target.value)}
            >
              <option value="" disabled>
                Select…
              </option>
              {prop.enum.map((option) => (
                <option key={String(option)} value={String(option)}>
                  {String(option)}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={
                prop.type === "number" || prop.type === "integer"
                  ? "number"
                  : "text"
              }
              placeholder={prop.description ?? String(prop.default ?? "")}
              className="w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
              value={String(values[key] ?? "")}
              onChange={(e) =>
                onChange(
                  key,
                  prop.type === "number" || prop.type === "integer"
                    ? e.target.valueAsNumber
                    : e.target.value
                )
              }
            />
          )}
        </label>
      ))}
    </div>
  );
}

/**
 * Renders one pending elicitation: a form generated from the request's
 * `requestedSchema` (form mode) or a link to open (url mode), with
 * accept / decline buttons that answer back to the agent.
 */
function ElicitationCard({
  elicitation,
  onRespond
}: {
  elicitation: PendingElicitation;
  onRespond: (id: string, result: ElicitResponse) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const params = elicitation.params as PendingElicitation["params"] & {
    mode?: string;
    url?: string;
  };
  const isUrlMode = params.mode === "url";
  const properties: Record<string, SchemaProperty> = isUrlMode
    ? {}
    : ((params.requestedSchema?.properties ?? {}) as Record<
        string,
        SchemaProperty
      >);

  const setValue = (key: string, value: unknown) =>
    setValues((v) => ({ ...v, [key]: value }));

  return (
    <Surface className="p-4 rounded-xl ring ring-kumo-accent">
      <div className="flex items-center gap-2">
        <Text size="sm" bold>
          Server needs your input
        </Text>
        <Badge variant="secondary">{elicitation.serverId}</Badge>
      </div>
      <span className="mt-1 block">
        <Text size="xs" variant="secondary">
          {params.message}
        </Text>
      </span>

      {isUrlMode ? (
        <div className="mt-3 flex items-center gap-2">
          <span className="font-mono truncate">
            <Text size="xs" variant="secondary">
              {params.url}
            </Text>
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              window.open(params.url, "_blank", "noopener,noreferrer")
            }
          >
            Open
          </Button>
        </div>
      ) : (
        <div className="mt-3">
          <SchemaFields
            properties={properties}
            values={values}
            onChange={setValue}
          />
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() =>
            onRespond(elicitation.id, {
              action: "accept",
              content: isUrlMode ? {} : values
            })
          }
        >
          {isUrlMode ? "Done" : "Submit"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onRespond(elicitation.id, { action: "decline", content: {} })
          }
        >
          Decline
        </Button>
      </div>
    </Surface>
  );
}

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
    <output className="flex items-center gap-2">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className={`text-xs ${text}`}>{label}</span>
    </output>
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

/** One tool: schema dump, an args form generated from its inputSchema, Run. */
function ToolCard({
  tool,
  onRun
}: {
  tool: { name: string; serverId: string; inputSchema?: unknown };
  onRun: (
    serverId: string,
    name: string,
    args: Record<string, unknown>
  ) => Promise<unknown>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<unknown>(null);
  const properties = ((
    tool.inputSchema as { properties?: Record<string, SchemaProperty> }
  )?.properties ?? {}) as Record<string, SchemaProperty>;

  const run = async () => {
    setResult("Running…");
    try {
      setResult(await onRun(tool.serverId, tool.name, values));
    } catch (error) {
      setResult(String(error));
    }
  };

  return (
    <Surface className="p-3 rounded-xl ring ring-kumo-line">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Text size="sm" bold>
            {tool.name}
          </Text>
          <Badge variant="secondary">{tool.serverId}</Badge>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<PlayIcon size={14} />}
          onClick={run}
        >
          Run
        </Button>
      </div>
      {Object.keys(properties).length > 0 && (
        <div className="mt-2">
          <SchemaFields
            properties={properties}
            values={values}
            onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
          />
        </div>
      )}
      <pre className="text-xs mt-1 whitespace-pre-wrap break-words text-kumo-subtle font-mono">
        {JSON.stringify(tool, null, 2)}
      </pre>
      {result !== null && (
        <pre className="text-xs mt-2 p-2 rounded-lg bg-kumo-elevated whitespace-pre-wrap break-words text-kumo-default font-mono">
          {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
        </pre>
      )}
    </Surface>
  );
}

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const mcpUrlInputRef = useRef<HTMLInputElement>(null);
  const mcpNameInputRef = useRef<HTMLInputElement>(null);
  const [mcpState, setMcpState] = useState<MCPServersState>({
    prompts: [],
    resources: [],
    servers: {},
    tools: []
  });
  const [elicitations, setElicitations] = useState<PendingElicitation[]>([]);

  const agent = useAgent({
    agent: "my-agent",
    name: sessionId!,
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onMcpUpdate: useCallback((mcpServers: MCPServersState) => {
      setMcpState(mcpServers);
    }, []),
    onMessage: useCallback((event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let message: PendingElicitation;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "mcp-elicitation") {
        setElicitations((current) => [...current, message]);
      }
    }, []),
    onOpen: useCallback(() => setConnectionStatus("connected"), [])
  });

  const respondToElicitation = async (id: string, result: ElicitResponse) => {
    setElicitations((current) => current.filter((e) => e.id !== id));
    await agent.call("respondToElicitation", [id, result]);
  };

  const runTool = (
    serverId: string,
    name: string,
    args: Record<string, unknown>
  ) => agent.call("callTool", [serverId, name, args]);

  function openPopup(authUrl: string) {
    window.open(
      authUrl,
      "popupWindow",
      "width=600,height=800,resizable=yes,scrollbars=yes"
    );
  }

  const handleMcpSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!mcpUrlInputRef.current || !mcpUrlInputRef.current.value.trim()) return;
    if (!mcpNameInputRef.current || !mcpNameInputRef.current.value.trim())
      return;

    const serverName = mcpNameInputRef.current.value;
    const serverUrl = mcpUrlInputRef.current.value;

    agent.call("addServer", [serverName, serverUrl]);

    mcpUrlInputRef.current.value = "";
    mcpNameInputRef.current.value = "";
  };

  const handleDisconnect = async (serverId: string) => {
    await agent.call("disconnectServer", [serverId]);
  };

  const serverEntries = Object.entries(mcpState.servers);

  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <PlugsConnectedIcon
              size={22}
              className="text-kumo-accent"
              weight="bold"
            />
            <h1 className="text-lg font-semibold text-kumo-default">
              MCP Client
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={connectionStatus} />
            <ModeToggle />
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
                  MCP Client
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    This Agent acts as an MCP client — dynamically connecting to
                    remote MCP servers, handling OAuth authentication
                    automatically, and aggregating tools, prompts, and resources
                    from all connected servers. Add a server URL below to get
                    started.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          {/* Add Server Form */}
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="mb-3">
              <Text size="sm" bold>
                Connect to an MCP Server
              </Text>
            </div>
            <form onSubmit={handleMcpSubmit} className="flex gap-2 items-end">
              <div className="w-40">
                <label className="block text-xs text-kumo-subtle mb-1">
                  Name
                  <input
                    aria-label="My Server"
                    ref={mcpNameInputRef}
                    type="text"
                    placeholder="My Server"
                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
                  />
                </label>
              </div>
              <div className="flex-1">
                <label className="block text-xs text-kumo-subtle mb-1">
                  URL
                  <input
                    aria-label="https://example.com/mcp"
                    ref={mcpUrlInputRef}
                    type="text"
                    placeholder="https://example.com/mcp"
                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
                  />
                </label>
              </div>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                icon={<PlusIcon size={14} />}
              >
                Add
              </Button>
            </form>
          </Surface>

          {/* Connected Servers */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <PlugIcon size={18} weight="bold" className="text-kumo-subtle" />
              <Text size="base" bold>
                Servers
              </Text>
              <Badge variant="secondary">{serverEntries.length}</Badge>
            </div>
            {serverEntries.length === 0 ? (
              <Empty
                icon={<PlugIcon size={32} />}
                title="No servers connected"
                description="Add an MCP server URL above to get started."
              />
            ) : (
              <div className="space-y-2">
                {serverEntries.map(([id, server]) => (
                  <Surface
                    key={id}
                    className="p-4 rounded-xl ring ring-kumo-line"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <Text size="sm" bold>
                            {server.name}
                          </Text>
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
                        <span className="mt-0.5 font-mono block">
                          <Text size="xs" variant="secondary">
                            {server.server_url}
                          </Text>
                        </span>
                        {server.state === "failed" && server.error && (
                          <span className="text-red-500 mt-1 block">
                            <Text size="xs">{server.error}</Text>
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {server.state === "authenticating" &&
                          server.auth_url && (
                            <Button
                              variant="primary"
                              size="sm"
                              icon={<SignInIcon size={14} />}
                              onClick={() =>
                                openPopup(server.auth_url as string)
                              }
                            >
                              Authorize
                            </Button>
                          )}
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<TrashIcon size={14} />}
                          onClick={() => handleDisconnect(id)}
                        />
                      </div>
                    </div>
                  </Surface>
                ))}
              </div>
            )}
          </section>

          {/* Aggregated Data */}
          {mcpState.tools.length > 0 && (
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
                <Badge variant="secondary">{mcpState.tools.length}</Badge>
              </div>
              <div className="space-y-2">
                {mcpState.tools.map((tool) => (
                  <ToolCard
                    key={`${tool.name}-${tool.serverId}`}
                    tool={tool}
                    onRun={runTool}
                  />
                ))}
              </div>
            </section>
          )}

          {mcpState.prompts.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <ChatTextIcon
                  size={18}
                  weight="bold"
                  className="text-kumo-subtle"
                />
                <Text size="base" bold>
                  Prompts
                </Text>
                <Badge variant="secondary">{mcpState.prompts.length}</Badge>
              </div>
              <div className="space-y-2">
                {mcpState.prompts.map((prompt) => (
                  <Surface
                    key={`${prompt.name}-${prompt.serverId}`}
                    className="p-3 rounded-xl ring ring-kumo-line"
                  >
                    <Text size="sm" bold>
                      {prompt.name}
                    </Text>
                    <pre className="text-xs mt-1 whitespace-pre-wrap break-words text-kumo-subtle font-mono">
                      {JSON.stringify(prompt, null, 2)}
                    </pre>
                  </Surface>
                ))}
              </div>
            </section>
          )}

          {mcpState.resources.length > 0 && (
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
                <Badge variant="secondary">{mcpState.resources.length}</Badge>
              </div>
              <div className="space-y-2">
                {mcpState.resources.map((resource) => (
                  <Surface
                    key={`${resource.name}-${resource.serverId}`}
                    className="p-3 rounded-xl ring ring-kumo-line"
                  >
                    <Text size="sm" bold>
                      {resource.name}
                    </Text>
                    <pre className="text-xs mt-1 whitespace-pre-wrap break-words text-kumo-subtle font-mono">
                      {JSON.stringify(resource, null, 2)}
                    </pre>
                  </Surface>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>

      {/* Pending elicitations — fixed overlay so they're visible no matter
          where on the page the tool was run from */}
      {elicitations.length > 0 && (
        <div className="fixed bottom-6 right-6 z-50 w-96 max-h-[80vh] overflow-auto space-y-2 shadow-lg">
          {elicitations.map((elicitation) => (
            <ElicitationCard
              key={elicitation.id}
              elicitation={elicitation}
              onRespond={respondToElicitation}
            />
          ))}
        </div>
      )}

      <footer className="border-t border-kumo-line py-3">
        <div className="flex justify-center">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
