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
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { McpCatalog } from "./demo-api";
import "./styles.css";

const INSTANCE_KEY = "mcp-client-instance";
const instanceName = localStorage.getItem(INSTANCE_KEY) ?? crypto.randomUUID();
localStorage.setItem(INSTANCE_KEY, instanceName);
const OBJECT_PATH = `/agents/mcp-client-object/${encodeURIComponent(instanceName)}`;
const OAUTH_WINDOW_FEATURES =
  "width=640,height=760,resizable=yes,scrollbars=yes";
const OAUTH_DIRECT_WINDOW_FEATURES = `${OAUTH_WINDOW_FEATURES},noopener`;
const EMPTY_CATALOG: McpCatalog = { servers: [], tools: [] };

type ConnectResult = {
  readonly id: string;
  readonly connection: { readonly state: string; readonly authUrl?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  const color =
    state === "ready"
      ? "bg-green-500"
      : state === "failed"
        ? "bg-red-500"
        : state === "authenticating"
          ? "bg-yellow-500"
          : "bg-blue-500";

  return (
    <Badge variant="secondary">
      <span className={`mr-1.5 inline-block size-1.5 rounded-full ${color}`} />
      {state}
    </Badge>
  );
}

function ToolCard({ tool }: { tool: McpCatalog["tools"][number] }) {
  const [argumentsJson, setArgumentsJson] = useState("{}");
  const [calling, setCalling] = useState(false);
  const [output, setOutput] = useState<unknown>();
  const [error, setError] = useState<string>();

  const callTool = async () => {
    setCalling(true);
    setOutput(undefined);
    setError(undefined);
    try {
      const args: unknown = JSON.parse(argumentsJson);
      if (!isRecord(args)) throw new Error("Arguments must be a JSON object");

      const response = await fetch(`${OBJECT_PATH}/tools/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverId: tool.serverId,
          name: tool.name,
          arguments: args
        })
      });
      const payload: unknown = await response.json();
      if (!isRecord(payload)) throw new Error("Invalid tool response");
      if (!response.ok || typeof payload.error === "string") {
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Tool call failed"
        );
      }
      setOutput(payload.result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCalling(false);
    }
  };

  const outputIsError = isRecord(output) && output.isError === true;
  const argumentsId = `tool-${encodeURIComponent(tool.serverId)}-${encodeURIComponent(tool.name)}`;

  return (
    <Surface className="rounded-xl p-4 ring ring-kumo-line">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-medium">{tool.name}</h3>
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

      <label className="mt-3 block" htmlFor={argumentsId}>
        <span className="mb-1 block text-xs font-medium text-kumo-subtle">
          Arguments (JSON)
        </span>
        <Textarea
          id={argumentsId}
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

      {error || output !== undefined ? (
        <pre
          className={`mt-3 overflow-x-auto whitespace-pre-wrap rounded-lg bg-kumo-elevated p-3 text-xs ${error || outputIsError ? "text-kumo-danger" : "text-kumo-default"}`}
        >
          {error ?? JSON.stringify(output, null, 2)}
        </pre>
      ) : null}
    </Surface>
  );
}

function App() {
  const [serverName, setServerName] = useState("cloudflare-mcp");
  const [serverUrl, setServerUrl] = useState("https://mcp.cloudflare.com/mcp");
  const [catalog, setCatalog] = useState<McpCatalog>(EMPTY_CATALOG);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(OBJECT_PATH);
      if (!response.ok) throw new Error(await response.text());
      // SAFETY: This route is owned by getMcpCatalog in the same example.
      setCatalog((await response.json()) as McpCatalog);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const popup = window.open("about:blank", "_blank", OAUTH_WINDOW_FEATURES);
    setConnecting(true);
    setError(undefined);
    try {
      const response = await fetch(`${OBJECT_PATH}/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: serverName, url: serverUrl })
      });
      if (!response.ok) throw new Error(await response.text());
      // SAFETY: The connect route returns this local protocol shape.
      const result = (await response.json()) as ConnectResult;
      if (result.connection.authUrl) {
        if (popup) {
          popup.opener = null;
          popup.location.assign(result.connection.authUrl);
        }
      } else {
        popup?.close();
      }
      await refresh();
    } catch (cause) {
      popup?.close();
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnecting(false);
    }
  };

  const removeServer = async (id: string) => {
    const response = await fetch(
      `${OBJECT_PATH}/servers/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    await refresh();
  };

  const authorizations = catalog.servers.filter((server) => server.authUrl);

  return (
    <div className="min-h-screen bg-kumo-elevated text-kumo-default">
      <header className="border-b border-kumo-line bg-kumo-base px-5 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-kumo-accent p-2 text-white">
              <PlugIcon size={20} weight="bold" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">MCP client capability</h1>
              <p className="text-xs text-kumo-subtle">
                Composable Agent + MCPClientManager
              </p>
            </div>
          </div>
          <div className="flex gap-2">
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

      <main className="mx-auto max-w-5xl space-y-5 px-5 py-6">
        <Surface className="rounded-xl p-4 ring ring-kumo-line">
          <div className="flex gap-3">
            <InfoIcon
              size={20}
              weight="bold"
              className="mt-0.5 shrink-0 text-kumo-accent"
            />
            <div>
              <Text size="sm" bold>
                Durable MCP client
              </Text>
              <span className="mt-1 block">
                <Text size="xs" variant="secondary">
                  Connect any Streamable HTTP MCP endpoint. The capability owns
                  persistence, restoration, and OAuth callback handling.
                </Text>
              </span>
            </div>
          </div>
        </Surface>

        <Surface className="rounded-xl p-5 ring ring-kumo-line">
          <div className="mb-4 flex items-center justify-between">
            <Text size="sm" bold>
              Connect an MCP server
            </Text>
            <Badge variant="secondary">Streamable HTTP</Badge>
          </div>
          <form
            onSubmit={connect}
            className="grid gap-3 md:grid-cols-[12rem_1fr_auto] md:items-end"
          >
            <label htmlFor="server-name">
              <span className="mb-1 block text-xs text-kumo-subtle">Name</span>
              <Input
                id="server-name"
                value={serverName}
                onChange={(event) => setServerName(event.target.value)}
                required
              />
            </label>
            <label htmlFor="server-url">
              <span className="mb-1 block text-xs text-kumo-subtle">
                MCP endpoint
              </span>
              <Input
                id="server-url"
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
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
              {connecting ? "Connecting…" : "Connect"}
            </Button>
          </form>
        </Surface>

        {authorizations.map((authorization) => (
          <Surface
            key={authorization.id}
            className="rounded-xl p-4 ring ring-kumo-accent"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <Text size="sm" bold>
                  Authorization required
                </Text>
                <p className="mt-1 text-xs text-kumo-subtle">
                  Finish OAuth for {authorization.name}.
                </p>
              </div>
              <Button
                variant="primary"
                icon={<SignInIcon size={16} />}
                onClick={() =>
                  window.open(
                    authorization.authUrl,
                    "_blank",
                    OAUTH_DIRECT_WINDOW_FEATURES
                  )
                }
              >
                Authorize
              </Button>
            </div>
          </Surface>
        ))}

        {error ? (
          <Surface className="rounded-xl p-4 ring ring-kumo-danger">
            <p className="whitespace-pre-wrap text-xs text-kumo-danger">
              {error}
            </p>
          </Surface>
        ) : null}

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Servers</h2>
            {loading ? <Badge variant="secondary">Loading…</Badge> : null}
          </div>
          {catalog.servers.length === 0 ? (
            <Empty
              icon={<PlugIcon size={24} />}
              title="No MCP servers"
              description="Connect a server to populate the catalog."
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
            <h2 className="text-base font-semibold">Tools</h2>
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
                <ToolCard key={`${tool.serverId}-${tool.name}`} tool={tool} />
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-kumo-line bg-kumo-base px-5 py-3">
        <div className="flex justify-center">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
