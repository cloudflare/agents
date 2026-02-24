import { useAgent } from "agents/react";
import { useCallback, useRef, useState } from "react";
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
  PlusIcon,
  PlugIcon,
  PlugsConnectedIcon,
  WrenchIcon,
  ChatTextIcon,
  DatabaseIcon,
  TrashIcon,
  SignInIcon,
  InfoIcon
} from "@phosphor-icons/react";
import type { MCPServersState } from "agents";
import { nanoid } from "nanoid";
import "./styles.css";

let sessionId = localStorage.getItem("sessionId");
if (!sessionId) {
  sessionId = nanoid(8);
  localStorage.setItem("sessionId", sessionId);
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

  const agent = useAgent({
    agent: "my-agent",
    name: sessionId!,
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onMcpUpdate: useCallback((mcpServers: MCPServersState) => {
      setMcpState(mcpServers);
    }, []),
    onOpen: useCallback(() => setConnectionStatus("connected"), [])
  });

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
                  <Surface
                    key={`${tool.name}-${tool.serverId}`}
                    className="p-3 rounded-xl ring ring-kumo-line"
                  >
                    <div className="flex items-center gap-2">
                      <Text size="sm" bold>
                        {tool.name}
                      </Text>
                      <Badge variant="secondary">{tool.serverId}</Badge>
                    </div>
                    <pre className="text-xs mt-1 whitespace-pre-wrap break-words text-kumo-subtle font-mono">
                      {JSON.stringify(tool, null, 2)}
                    </pre>
                  </Surface>
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
