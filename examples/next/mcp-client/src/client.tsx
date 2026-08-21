import {
  Badge,
  Button,
  Empty,
  Input,
  PoweredByCloudflare,
  Surface,
  Text,
  Textarea
} from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  InfoIcon,
  MoonIcon,
  PlugIcon,
  SignInIcon,
  SunIcon,
  TrashIcon,
  WrenchIcon
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { McpCatalog } from "./demo-api";
import "./styles.css";

const DEFAULT_SERVER_NAME = "cloudflare-mcp";
const DEFAULT_SERVER_URL = "https://mcp.cloudflare.com/mcp";
const EMPTY_CATALOG: McpCatalog = {
  servers: [],
  tools: []
};

const OAUTH_WINDOW_FEATURES =
  "width=640,height=760,resizable=yes,scrollbars=yes";

type ConnectResult = {
  readonly id: string;
  readonly connection: {
    readonly state: string;
    readonly authUrl?: string;
  };
};

type PendingAuthorization = {
  readonly serverId: string;
  readonly url: string;
};

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") ?? "light"
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
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function StatusBadge({ state }: { state: string }) {
  const dot =
    state === "ready"
      ? "bg-green-500"
      : state === "failed"
        ? "bg-red-500"
        : state === "authenticating"
          ? "bg-yellow-500"
          : "bg-blue-500";

  return (
    <Badge variant="secondary">
      <span className={`mr-1.5 inline-block size-1.5 rounded-full ${dot}`} />
      {state}
    </Badge>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ToolCard({
  tool,
  objectPath
}: {
  tool: McpCatalog["tools"][number];
  objectPath: string;
}) {
  const [argumentsJson, setArgumentsJson] = useState("{}");
  const [calling, setCalling] = useState(false);
  const [result, setResult] = useState<unknown>();
  const [callError, setCallError] = useState<string>();

  const callTool = async () => {
    setCalling(true);
    setResult(undefined);
    setCallError(undefined);
    try {
      const parsed: unknown = JSON.parse(argumentsJson);
      if (!isRecord(parsed)) {
        throw new Error("Tool arguments must be a JSON object");
      }
      const response = await fetch(`${objectPath}/tools/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverId: tool.serverId,
          name: tool.name,
          arguments: parsed
        })
      });
      const payload: unknown = await response.json();
      if (!isRecord(payload)) throw new Error("Invalid tool response");
      if (!response.ok || typeof payload.error === "string") {
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Tool call failed"
        );
      }
      setResult(payload.result);
    } catch (cause) {
      setCallError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCalling(false);
    }
  };

  const resultIsError = isRecord(result) && result.isError === true;

  return (
    <Surface className="rounded-xl p-4 ring ring-kumo-line">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-medium text-kumo-default">
            {tool.name}
          </h3>
          {tool.description ? (
            <p className="mt-1 text-xs leading-5 text-kumo-subtle">
              {tool.description}
            </p>
          ) : null}
        </div>
        <Badge variant="secondary">{tool.serverId}</Badge>
      </div>

      <details className="mt-3 text-xs text-kumo-subtle">
        <summary className="cursor-pointer">Input schema</summary>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-kumo-elevated p-3 font-mono text-[11px] leading-5">
          {JSON.stringify(tool.inputSchema, null, 2)}
        </pre>
      </details>

      <label
        className="mt-3 block"
        htmlFor={`tool-${tool.serverId}-${tool.name}`}
      >
        <span className="mb-1 block text-xs font-medium text-kumo-subtle">
          Arguments (JSON)
        </span>
        <Textarea
          id={`tool-${tool.serverId}-${tool.name}`}
          value={argumentsJson}
          onChange={(event) => setArgumentsJson(event.target.value)}
          spellCheck={false}
          className="min-h-24 resize-y font-mono text-xs"
        />
      </label>

      <Button
        className="mt-3"
        variant="primary"
        disabled={calling}
        icon={<WrenchIcon size={16} />}
        onClick={() => void callTool()}
      >
        {calling ? "Calling…" : "Call tool"}
      </Button>

      {callError ? (
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-lg bg-kumo-elevated p-3 text-xs text-kumo-danger">
          {callError}
        </pre>
      ) : result !== undefined ? (
        <pre
          className={`mt-3 overflow-x-auto whitespace-pre-wrap rounded-lg bg-kumo-elevated p-3 text-xs ${resultIsError ? "text-kumo-danger" : "text-kumo-default"}`}
        >
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </Surface>
  );
}

function App() {
  const [instanceName, setInstanceName] = useState(
    () => localStorage.getItem("mcp-capability-instance") ?? "demo"
  );
  const [serverName, setServerName] = useState(DEFAULT_SERVER_NAME);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [catalog, setCatalog] = useState<McpCatalog>(EMPTY_CATALOG);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();
  const [authorization, setAuthorization] = useState<PendingAuthorization>();

  const objectPath = useMemo(
    () =>
      `/agents/mcp-client-object/${encodeURIComponent(
        instanceName.trim() || "demo"
      )}`,
    [instanceName]
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(objectPath);
      if (!response.ok) throw new Error(await response.text());
      // SAFETY: objectPath is served by McpClientObject.onRequest, whose JSON
      // response is the exported McpCatalog shape consumed by this same app.
      const nextCatalog = (await response.json()) as McpCatalog;
      setCatalog(nextCatalog);
      const pending = nextCatalog.servers.find((server) => server.authUrl);
      setAuthorization(
        pending?.authUrl
          ? { serverId: pending.id, url: pending.authUrl }
          : undefined
      );
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [objectPath]);

  useEffect(() => {
    localStorage.setItem("mcp-capability-instance", instanceName);
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_500);
    return () => window.clearInterval(timer);
  }, [instanceName, refresh]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return;
      if (
        typeof event.data !== "object" ||
        event.data === null ||
        !("type" in event.data) ||
        event.data.type !== "mcp-oauth-complete"
      ) {
        return;
      }
      setAuthorization(undefined);
      void refresh();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refresh]);

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const authorizationWindow = window.open(
      "about:blank",
      "mcp-oauth",
      OAUTH_WINDOW_FEATURES
    );
    setConnecting(true);
    setError(undefined);
    try {
      const response = await fetch(`${objectPath}/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: serverName, url: serverUrl })
      });
      if (!response.ok) throw new Error(await response.text());
      // SAFETY: The connect endpoint always returns the manager's connection
      // result together with the normalized server id.
      const result = (await response.json()) as ConnectResult;
      if (
        result.connection.state === "authenticating" &&
        result.connection.authUrl
      ) {
        setAuthorization({
          serverId: result.id,
          url: result.connection.authUrl
        });
        authorizationWindow?.location.assign(result.connection.authUrl);
      } else {
        authorizationWindow?.close();
        setAuthorization(undefined);
      }
      await refresh();
    } catch (cause) {
      authorizationWindow?.close();
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnecting(false);
    }
  };

  const removeServer = async (id: string) => {
    setError(undefined);
    try {
      const response = await fetch(
        `${objectPath}/servers/${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
      if (!response.ok) throw new Error(await response.text());
      if (authorization?.serverId === id) setAuthorization(undefined);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="min-h-screen bg-kumo-elevated text-kumo-default">
      <header className="border-b border-kumo-line bg-kumo-base px-5 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-kumo-accent p-2 text-white">
              <PlugIcon size={20} weight="bold" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">MCP client capability</h1>
              <p className="text-xs text-kumo-subtle">
                Plain Durable Object + Lifecycle + MCPClientManager
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              shape="square"
              aria-label="Refresh catalog"
              onClick={() => void refresh()}
              icon={<ArrowClockwiseIcon size={16} />}
            />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-5 px-5 py-6">
        <Surface className="rounded-xl p-4 ring ring-kumo-line">
          <div className="flex gap-3">
            <InfoIcon
              size={20}
              weight="bold"
              className="mt-0.5 shrink-0 text-kumo-accent"
            />
            <div>
              <Text size="sm" bold>
                What this demo proves
              </Text>
              <span className="mt-1 block">
                <Text size="xs" variant="secondary">
                  MCPClientManager owns its schema, restores connections after
                  Durable Object eviction, and intercepts OAuth callbacks as a
                  lifecycle capability. The host extends only DurableObject.
                </Text>
              </span>
            </div>
          </div>
        </Surface>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
          <Surface className="rounded-xl p-5 ring ring-kumo-line">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <Text size="sm" bold>
                  Connect an MCP server
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    Enter any Streamable HTTP MCP endpoint.
                  </Text>
                </span>
              </div>
              <Badge variant="secondary">Streamable HTTP</Badge>
            </div>

            <form onSubmit={connect} className="space-y-3">
              <label className="block" htmlFor="server-name">
                <span className="mb-1 block text-xs font-medium text-kumo-subtle">
                  Server name
                </span>
                <Input
                  id="server-name"
                  value={serverName}
                  onChange={(event) => setServerName(event.target.value)}
                  placeholder="cloudflare-docs"
                  required
                />
              </label>
              <label className="block" htmlFor="server-url">
                <span className="mb-1 block text-xs font-medium text-kumo-subtle">
                  MCP endpoint
                </span>
                <Input
                  id="server-url"
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                  placeholder="https://example.com/mcp"
                  type="url"
                  required
                />
              </label>
              <Button
                variant="primary"
                type="submit"
                disabled={connecting}
                icon={<PlugIcon size={16} />}
              >
                {connecting ? "Connecting…" : "Connect server"}
              </Button>
            </form>
          </Surface>

          <Surface className="rounded-xl p-5 ring ring-kumo-line">
            <Text size="sm" bold>
              Durable Object instance
            </Text>
            <span className="mt-1 block">
              <Text size="xs" variant="secondary">
                Change the name to switch to an isolated MCP catalog.
              </Text>
            </span>
            <div className="mt-4">
              <label className="block" htmlFor="instance-name">
                <span className="mb-1 block text-xs font-medium text-kumo-subtle">
                  Instance name
                </span>
                <Input
                  id="instance-name"
                  value={instanceName}
                  onChange={(event) => setInstanceName(event.target.value)}
                  placeholder="demo"
                />
              </label>
              <p className="mt-3 break-all font-mono text-xs text-kumo-subtle">
                {objectPath}
              </p>
            </div>
          </Surface>
        </div>

        {authorization ? (
          <Surface className="rounded-xl p-4 ring ring-kumo-accent">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Text size="sm" bold>
                  Authorization required
                </Text>
                <p className="mt-1 text-xs text-kumo-subtle">
                  Finish OAuth for {authorization.serverId}. The popup will
                  notify this page and the restored catalog will refresh.
                </p>
              </div>
              <Button
                variant="primary"
                icon={<SignInIcon size={16} />}
                onClick={() =>
                  window.open(
                    authorization.url,
                    "mcp-oauth",
                    OAUTH_WINDOW_FEATURES
                  )
                }
              >
                Authorize
              </Button>
            </div>
          </Surface>
        ) : null}

        {error ? (
          <Surface className="rounded-xl p-4 ring ring-kumo-danger">
            <Text size="sm" bold>
              Request failed
            </Text>
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-kumo-danger">
              {error}
            </p>
          </Surface>
        ) : null}

        <section>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold">Connected servers</h2>
              <p className="text-xs text-kumo-subtle">
                Persisted in this Durable Object and restored on its next wake.
              </p>
            </div>
            {loading ? <Badge variant="secondary">Loading…</Badge> : null}
          </div>

          {catalog.servers.length === 0 ? (
            <Empty
              icon={<PlugIcon size={24} />}
              title="No MCP servers"
              description="Connect an MCP server above to populate the catalog."
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {catalog.servers.map((server) => (
                <Surface
                  key={server.id}
                  className="rounded-xl p-4 ring ring-kumo-line"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Text size="sm" bold>
                          {server.name}
                        </Text>
                        <StatusBadge state={server.state} />
                      </div>
                      <p className="mt-2 break-all font-mono text-xs text-kumo-subtle">
                        {server.url}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      shape="square"
                      aria-label={`Remove ${server.name}`}
                      onClick={() => void removeServer(server.id)}
                      icon={<TrashIcon size={16} />}
                    />
                  </div>
                </Surface>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold">Tools</h2>
              <p className="text-xs text-kumo-subtle">
                Enter a JSON object and invoke a discovered MCP tool directly.
              </p>
            </div>
            <Badge variant="secondary">{catalog.tools.length}</Badge>
          </div>

          {catalog.tools.length === 0 ? (
            <Empty
              icon={<WrenchIcon size={24} />}
              title="No tools discovered"
              description="Authorize and connect a server to call its tools."
            />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {catalog.tools.map((tool) => (
                <ToolCard
                  key={`${tool.serverId}-${tool.name}`}
                  tool={tool}
                  objectPath={objectPath}
                />
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-kumo-line bg-kumo-base px-5 py-3">
        <div className="mx-auto flex max-w-6xl justify-center">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
