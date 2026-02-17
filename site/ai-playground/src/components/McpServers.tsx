import { useEffect, useRef, useState } from "react";
import {
  GearIcon,
  KeyIcon,
  EyeIcon,
  EyeSlashIcon,
  ArrowsClockwiseIcon,
  CaretDownIcon
} from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import type { Playground, PlaygroundState } from "../server";
import type { useAgent } from "agents/react";
import LocalhostWarningModal from "./LocalhostWarningModal";
import { McpInfoIcon } from "./Icons";

export type McpServerInfo = {
  id: string;
  name?: string;
  url?: string;
  state: string;
  error?: string | null;
};

export type McpServersComponentState = {
  servers: McpServerInfo[];
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
};

type McpServersProps = {
  agent: ReturnType<typeof useAgent<Playground, PlaygroundState>>;
  mcpState: McpServersComponentState;
  mcpLogs: Array<{ timestamp: number; status: string; serverUrl?: string }>;
};

export function McpServers({ agent, mcpState, mcpLogs }: McpServersProps) {
  const [serverUrl, setServerUrl] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showLocalhostWarning, setShowLocalhostWarning] = useState(false);
  const [error, setError] = useState<string>("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [disconnectingServerId, setDisconnectingServerId] = useState<
    string | null
  >(null);

  const hasConnectingServer = mcpState.servers.some(
    (s) =>
      s.state === "discovering" ||
      s.state === "connecting" ||
      s.state === "connected" ||
      s.state === "authenticating"
  );

  const authenticatingServer = mcpState.servers.find(
    (s) => s.state === "authenticating"
  );

  const logRef = useRef<HTMLDivElement>(null);
  const [showAuth, setShowAuth] = useState<boolean>(false);
  const [headerKey, setHeaderKey] = useState<string>(() => {
    return sessionStorage.getItem("mcpHeaderKey") || "Authorization";
  });
  const [bearerToken, setBearerToken] = useState<string>(() => {
    return sessionStorage.getItem("mcpBearerToken") || "";
  });
  const [showToken, setShowToken] = useState<boolean>(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  const toggleToolExpansion = (toolName: string) => {
    setExpandedTools((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(toolName)) {
        newSet.delete(toolName);
      } else {
        newSet.add(toolName);
      }
      return newSet;
    });
  };

  const clearAuthFields = () => {
    setHeaderKey("Authorization");
    setBearerToken("");
    sessionStorage.removeItem("mcpHeaderKey");
    sessionStorage.removeItem("mcpBearerToken");
  };

  const handleConnect = async () => {
    if (!serverUrl) {
      setError("Please enter a server URL");
      return;
    }

    try {
      const url = new URL(serverUrl);
      const hostname = url.hostname.toLowerCase();
      if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "0.0.0.0" ||
        hostname === "::1"
      ) {
        setShowLocalhostWarning(true);
        return;
      }
    } catch (_err) {
      // Invalid URL, let the server handle it
    }

    setIsConnecting(true);
    setError("");

    try {
      let headers: Record<string, string> | undefined;
      if (headerKey && bearerToken) {
        headers = {
          [headerKey]: `Bearer ${bearerToken}`
        };
      }

      const result = (await agent.stub.connectMCPServer(serverUrl, headers)) as
        | { authUrl?: string }
        | undefined;

      if (result?.authUrl) {
        openOAuthPopup(result.authUrl);
      }

      setServerUrl("");
      clearAuthFields();
      setShowAuth(false);
    } catch (err: unknown) {
      console.error("[McpServers] Connection error:", err);
      setError(
        err instanceof Error ? err.message : "Failed to connect to MCP server"
      );
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async (serverId: string) => {
    setDisconnectingServerId(serverId);
    setError("");

    try {
      await agent.stub.disconnectMCPServer(serverId);
    } catch (err: unknown) {
      console.error("[McpServers] Disconnect error:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Failed to disconnect from MCP server"
      );
    } finally {
      setDisconnectingServerId(null);
    }
  };

  const openOAuthPopup = (authUrl: string) => {
    window.open(
      authUrl,
      "mcpOAuthWindow",
      "width=600,height=800,resizable=yes,scrollbars=yes,toolbar=yes,menubar=no,location=no,directories=no,status=yes"
    );
  };

  // Auto-scroll debug log when new entries arrive
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [mcpLogs]);

  const statusColors: Record<string, string> = {
    discovering:
      "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-500/15 dark:text-blue-400 dark:border-blue-400/30",
    authenticating:
      "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-400/30",
    connecting:
      "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-500/15 dark:text-blue-400 dark:border-blue-400/30",
    connected:
      "bg-green-100 text-green-700 border-green-300 dark:bg-green-500/15 dark:text-green-400 dark:border-green-400/30",
    ready:
      "bg-green-100 text-green-700 border-green-300 dark:bg-green-500/15 dark:text-green-400 dark:border-green-400/30",
    failed:
      "bg-red-100 text-red-700 border-red-300 dark:bg-red-500/15 dark:text-red-400 dark:border-red-400/30",
    "not-connected":
      "bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-500/15 dark:text-gray-400 dark:border-gray-400/30"
  };

  const statusLabel: Record<string, string> = {
    discovering: "Discovering",
    authenticating: "Authenticating",
    connecting: "Connecting",
    connected: "Connected",
    ready: "Ready",
    failed: "Failed",
    "not-connected": "Not Connected"
  };

  const getStatusBadge = (state: string) => (
    <span
      data-testid="status"
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${statusColors[state] || "bg-gray-500/15 text-gray-600 dark:text-gray-400 border-gray-400/30"}`}
    >
      {statusLabel[state] || "Unknown"}
    </span>
  );

  return (
    <section className="bg-kumo-base px-3 py-2">
      <div className="flex items-center">
        <span className="text-xs font-semibold text-kumo-secondary uppercase tracking-wide">
          MCP Servers
        </span>
        <div className="ml-2 mt-0.5">
          <a
            href="https://developers.cloudflare.com/agents/guides/remote-mcp-server/"
            target="_blank"
            rel="noopener noreferrer"
            title="Learn more about MCP Servers"
          >
            <McpInfoIcon />
          </a>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto"
          onClick={() => setShowSettings(!showSettings)}
          icon={<GearIcon size={14} />}
          title="Debug Log"
        />
      </div>

      {error && (
        <div className="mt-2 flex items-start gap-2 p-2 rounded-md bg-red-500/10 border border-red-300 text-xs text-kumo-danger">
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError("")}
            className="text-kumo-secondary hover:text-kumo-default shrink-0"
          >
            ×
          </button>
        </div>
      )}

      <div className="mt-2">
        {/* Add new server form */}
        <div className="relative mb-2">
          <div className="flex space-x-1.5">
            <input
              type="text"
              className="grow p-1.5 text-sm border border-kumo-line rounded-md bg-kumo-base text-kumo-default hover:bg-kumo-tint focus:outline-none focus:ring-1 focus:ring-kumo-ring"
              placeholder="MCP server URL"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
            />
            <button
              type="button"
              className={`p-1.5 border rounded-md transition-colors ${
                showAuth || (headerKey && bearerToken)
                  ? "border-orange-400 bg-orange-500/10 text-orange-500"
                  : "border-kumo-line text-kumo-secondary hover:bg-kumo-tint"
              }`}
              onClick={() => setShowAuth(!showAuth)}
              title="Authentication settings"
            >
              <KeyIcon size={16} />
            </button>
            <button
              type="button"
              className="bg-ai-loop bg-size-[200%_100%] hover:animate-gradient-background text-white rounded-md shadow-sm py-1.5 px-3 text-xs font-medium disabled:opacity-50"
              onClick={
                authenticatingServer
                  ? () => handleDisconnect(authenticatingServer.id)
                  : handleConnect
              }
              disabled={
                isConnecting ||
                (hasConnectingServer && !authenticatingServer) ||
                (!serverUrl && !authenticatingServer)
              }
            >
              {authenticatingServer
                ? "Cancel"
                : isConnecting || hasConnectingServer
                  ? "..."
                  : "Add"}
            </button>
          </div>

          {/* Auth dropdown */}
          {showAuth && (
            <div className="absolute z-10 mt-1.5 w-full bg-kumo-base border border-kumo-line rounded-md shadow-lg p-2.5 space-y-2">
              <div>
                <label
                  htmlFor="header-name"
                  className="block text-[11px] font-medium text-kumo-secondary mb-0.5"
                >
                  Header Name
                </label>
                <input
                  type="text"
                  className="w-full p-1.5 border border-kumo-line rounded-md text-xs bg-kumo-base text-kumo-default hover:bg-kumo-tint focus:outline-none focus:ring-1 focus:ring-kumo-ring"
                  placeholder="e.g., Authorization, X-API-Key"
                  value={headerKey}
                  onChange={(e) => {
                    const newValue = e.target.value;
                    setHeaderKey(newValue);
                    sessionStorage.setItem("mcpHeaderKey", newValue);
                  }}
                />
              </div>
              <div>
                <label
                  htmlFor="bearer-value"
                  className="block text-[11px] font-medium text-kumo-secondary mb-0.5"
                >
                  Bearer Value
                </label>
                <div className="relative">
                  <input
                    type={showToken ? "text" : "password"}
                    className="w-full p-1.5 pr-8 border border-kumo-line rounded-md text-xs bg-kumo-base text-kumo-default hover:bg-kumo-tint focus:outline-none focus:ring-1 focus:ring-kumo-ring"
                    placeholder="API key or token"
                    value={bearerToken}
                    onChange={(e) => {
                      const newValue = e.target.value;
                      setBearerToken(newValue);
                      sessionStorage.setItem("mcpBearerToken", newValue);
                    }}
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 pr-2 flex items-center text-kumo-secondary hover:text-kumo-default"
                    onClick={() => setShowToken(!showToken)}
                  >
                    {showToken ? (
                      <EyeSlashIcon size={14} />
                    ) : (
                      <EyeIcon size={14} />
                    )}
                  </button>
                </div>
              </div>
              {headerKey && bearerToken && (
                <div className="text-[11px] text-kumo-secondary">
                  Will send: {headerKey}: Bearer •••••••
                </div>
              )}
            </div>
          )}
        </div>

        {/* Connected Servers List */}
        {mcpState.servers.length > 0 && (
          <div className="mb-2 space-y-1.5">
            {mcpState.servers.map((server) => (
              <div
                key={server.id}
                className={`p-1.5 border rounded-md ${
                  server.state === "failed"
                    ? "border-red-300 bg-red-500/10"
                    : "border-kumo-line bg-kumo-control"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-1.5 min-w-0 flex-1">
                    {getStatusBadge(server.state)}
                    <span
                      className="text-xs text-kumo-secondary truncate"
                      title={server.url}
                    >
                      {server.url}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ml-1.5 shrink-0 inline-flex items-center justify-center size-5 rounded bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-500/15 dark:text-red-400 dark:hover:bg-red-500/25 disabled:opacity-50 text-xs font-medium"
                    onClick={() => handleDisconnect(server.id)}
                    disabled={disconnectingServerId === server.id}
                  >
                    {disconnectingServerId === server.id ? "..." : "×"}
                  </button>
                </div>
                {server.state === "failed" && server.error && (
                  <div className="mt-1 text-[11px] text-kumo-danger wrap-break-word">
                    {server.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Debug Log */}
        {showSettings && (
          <div className="mt-2">
            <div className="font-medium text-xs block mb-1 text-kumo-default">
              Debug Log
            </div>
            <div
              ref={logRef}
              className="border border-kumo-line rounded-md p-1.5 bg-kumo-control h-32 overflow-y-auto font-mono text-[11px]"
            >
              {mcpLogs.map((log) => {
                const level =
                  log.status === "failed"
                    ? "error"
                    : log.status === "connecting" ||
                        log.status === "connected" ||
                        log.status === "discovering" ||
                        log.status === "authenticating" ||
                        log.status === "ready"
                      ? "info"
                      : "debug";

                const time = new Date(log.timestamp).toLocaleTimeString();

                return (
                  <div
                    key={log.timestamp}
                    className={`py-0.5 ${
                      level === "debug"
                        ? "text-kumo-inactive"
                        : level === "info"
                          ? "text-kumo-info"
                          : "text-kumo-danger"
                    }`}
                  >
                    [{level}] {time} - {log.status}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Available Tools */}
        {mcpState.servers.some(
          (s) =>
            s.state === "connected" ||
            s.state === "ready" ||
            s.state === "discovering"
        ) && (
          <div className="mt-2 border border-kumo-line rounded-md bg-kumo-tint p-2">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-xs font-medium text-kumo-default">
                Tools ({mcpState.tools.length})
              </div>
              <button
                type="button"
                onClick={async () => {
                  for (const server of mcpState.servers) {
                    if (server.state === "ready") {
                      try {
                        await agent.stub.refreshMcpTools(server.id);
                      } catch (err) {
                        console.error(
                          "[McpServers] Failed to refresh tools:",
                          err
                        );
                      }
                    }
                  }
                }}
                className="p-1 hover:bg-kumo-interact text-kumo-default rounded transition-colors"
                title="Refresh server capabilities"
                aria-label="Refresh server capabilities"
              >
                <ArrowsClockwiseIcon size={14} />
              </button>
            </div>
            {mcpState.tools.length > 0 ? (
              <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                {mcpState.tools.map((tool: Tool) => {
                  const isExpanded = expandedTools.has(tool.name);
                  return (
                    <div
                      key={tool.name}
                      className="bg-kumo-base rounded border border-kumo-line"
                    >
                      <button
                        type="button"
                        onClick={() => toggleToolExpansion(tool.name)}
                        className="w-full flex items-center justify-between p-1.5 text-left hover:bg-kumo-tint rounded transition-colors"
                      >
                        <div className="font-medium text-[11px] text-kumo-default">
                          {tool.name.replace("tool_", "").replace(/_/g, " ")}
                        </div>
                        {tool.description && (
                          <CaretDownIcon
                            size={10}
                            className={`text-kumo-secondary shrink-0 ml-1.5 transition-transform ${
                              isExpanded ? "rotate-180" : ""
                            }`}
                          />
                        )}
                      </button>
                      {tool.description && isExpanded && (
                        <div className="px-1.5 pb-1.5 text-[11px] text-kumo-secondary border-t border-kumo-line pt-1.5">
                          <Streamdown
                            className="sd-theme"
                            mode="static"
                            controls={false}
                          >
                            {tool.description}
                          </Streamdown>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-kumo-secondary text-center py-3">
                {mcpState.servers.some((s) => s.state === "discovering")
                  ? "Discovering tools..."
                  : "No tools available. Click refresh."}
              </div>
            )}
          </div>
        )}
      </div>

      <LocalhostWarningModal
        visible={showLocalhostWarning}
        handleHide={() => setShowLocalhostWarning(false)}
      />
    </section>
  );
}
