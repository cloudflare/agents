/** biome-ignore-all lint/correctness/useUniqueElementIds: it's fine */
import { useEffect, useRef, useState } from "react";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import type { Playground, PlaygroundState } from "../server";
import type { useAgent } from "agents/react";
import LocalhostWarningModal from "./LocalhostWarningModal";

export type McpComponentState = {
  id?: string;
  name?: string;
  state: string;
  url?: string;
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
};

type McpServersProps = {
  agent: ReturnType<typeof useAgent<Playground, PlaygroundState>>;
  mcpState: McpComponentState;
  mcpLogs: Array<{ timestamp: number; status: string; serverUrl?: string }>;
};

export function McpServers({ agent, mcpState, mcpLogs }: McpServersProps) {
  const [serverUrl, setServerUrl] = useState(() => {
    return sessionStorage.getItem("mcpServerUrl") || "";
  });
  const [_transportType, _setTransportType] = useState<"auto" | "http" | "sse">(
    () => {
      return (
        (sessionStorage.getItem("mcpTransportType") as
          | "auto"
          | "http"
          | "sse") || "auto"
      );
    }
  );
  const [isActive, setIsActive] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showLocalhostWarning, setShowLocalhostWarning] = useState(false);

  // Update isActive based on mcpState
  useEffect(() => {
    console.log("[McpServers] mcpState updated:", mcpState);
    if (mcpState?.state === "ready") {
      setIsActive(true);
    } else if (
      mcpState?.state === "failed" ||
      mcpState?.state === "not-connected"
    ) {
      setIsActive(false);
    }
  }, [mcpState?.state, mcpState]);
  const [error, setError] = useState<string>("");
  const [isConnecting, setIsConnecting] = useState(false);

  // Clear error when connection succeeds
  useEffect(() => {
    if (mcpState?.state === "ready") {
      setError("");
    }
  }, [mcpState?.state]);

  // Update isConnecting based on mcpState
  // SDK states: "discovering" | "authenticating" | "connecting" | "ready" | "failed"
  useEffect(() => {
    if (
      mcpState?.state === "discovering" ||
      mcpState?.state === "connecting" ||
      mcpState?.state === "authenticating"
    ) {
      setIsConnecting(true);
    } else {
      setIsConnecting(false);
    }
  }, [mcpState?.state]);

  const logRef = useRef<HTMLDivElement>(null);
  const [showAuth, setShowAuth] = useState<boolean>(false);
  const [headerKey, setHeaderKey] = useState<string>(() => {
    return sessionStorage.getItem("mcpHeaderKey") || "Authorization";
  });
  const [bearerToken, setBearerToken] = useState<string>(() => {
    return sessionStorage.getItem("mcpBearerToken") || "";
  });
  const [showToken, setShowToken] = useState<boolean>(false);

  // Handle connection
  const handleConnect = async () => {
    if (!serverUrl) {
      setError("Please enter a server URL");
      return;
    }

    // Check if URL contains localhost or 127.0.0.1
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
    } catch (err) {
      // Invalid URL, let the server handle it
    }

    console.log("[McpServers] handleConnect called with URL:", serverUrl);
    setIsConnecting(true);
    setError("");

    try {
      // Build headers object to send to server
      let headers: Record<string, string> | undefined;
      if (headerKey && bearerToken) {
        headers = {
          [headerKey]: `Bearer ${bearerToken}`
        };
      }

      console.log(
        "[McpServers] Calling connectMCPServer with headers:",
        headers
      );
      const result = (await agent.stub.connectMCPServer(serverUrl, headers)) as
        | { authUrl?: string }
        | undefined;
      console.log("[McpServers] connectMCPServer result:", result);

      // If authUrl is returned, open the OAuth popup immediately
      if (result?.authUrl) {
        console.log(
          "[McpServers] Auth required, opening popup with URL:",
          result.authUrl
        );
        openOAuthPopup(result.authUrl);
      } else {
        console.log("[McpServers] No auth required, connection successful");
        setIsActive(true);
      }
    } catch (err: unknown) {
      console.error("[McpServers] Connection error:", err);
      setError(
        err instanceof Error ? err.message : "Failed to connect to MCP server"
      );
      setIsActive(false);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    console.log(
      "[McpServers] handleDisconnect called with serverId:",
      mcpState.id
    );
    setIsConnecting(true);
    setError("");

    try {
      // Call the agent to actually disconnect from the MCP server
      await agent.stub.disconnectMCPServer(mcpState.id);
      console.log("[McpServers] Successfully disconnected from MCP server");

      // The SDK will broadcast the updated state, which will trigger our useEffect
      // and update isActive automatically
    } catch (err: unknown) {
      console.error("[McpServers] Disconnect error:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Failed to disconnect from MCP server"
      );
    } finally {
      setIsConnecting(false);
    }
  };

  const openOAuthPopup = (authUrl: string) => {
    console.log("[McpServers] Opening OAuth popup with URL:", authUrl);
    window.open(
      authUrl,
      "mcpOAuthWindow",
      "width=600,height=800,resizable=yes,scrollbars=yes,toolbar=yes,menubar=no,location=no,directories=no,status=yes"
    );
  };

  // Auto-scroll log to bottom when new events arrive
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, []);

  // Generate status badge based on connection state
  const getStatusBadge = () => {
    // SDK connection states: "discovering" | "authenticating" | "connecting" | "ready" | "failed"
    const states: Record<string, { colors: string; label: string }> = {
      discovering: {
        colors: "bg-blue-100 text-blue-800",
        label: "Discovering"
      },
      authenticating: {
        colors: "bg-purple-100 text-purple-800",
        label: "Authenticating"
      },
      connecting: {
        colors: "bg-yellow-100 text-yellow-800",
        label: "Connecting"
      },
      ready: {
        colors: "bg-green-100 text-green-800",
        label: "Connected"
      },
      failed: {
        colors: "bg-red-100 text-red-800",
        label: "Failed"
      },
      "not-connected": {
        colors: "bg-gray-100 text-gray-800",
        label: "Not Connected"
      }
    };

    // Get the status from mcpState (mapped from SDK's 'state' field)
    const status = mcpState?.state || "not-connected";
    const { colors, label } = states[status] || states["not-connected"];

    return (
      <span
        data-testid="status"
        className={`px-2 py-1 rounded-full text-xs font-medium ${colors}`}
      >
        {label}
      </span>
    );
  };

  return (
    <section className="rounded-lg bg-white p-4">
      <div className="flex align-middle">
        <span className="text-lg font-semibold">MCP Servers</span>
        <div className="ml-3 mt-1">
          <a
            href="https://developers.cloudflare.com/agents/guides/remote-mcp-server/"
            target="_blank"
            rel="noopener noreferrer"
            title="Learn more about MCP Servers"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <title>MCP Servers</title>
              <path
                d="M8 0C3.58172 0 0 3.58172 0 8C0 12.4183 3.58172 16 8 16C12.4183 16 16 12.4183 16 8C16 3.58172 12.4183 0 8 0ZM8 14.5C4.41015 14.5 1.5 11.5899 1.5 8C1.5 4.41015 4.41015 1.5 8 1.5C11.5899 1.5 14.5 4.41015 14.5 8C14.5 11.5899 11.5899 14.5 8 14.5Z"
                fill="url(#paint0_linear_1012_8647)"
              />
              <path
                d="M8 3.5C7.58579 3.5 7.25 3.83579 7.25 4.25V8.75C7.25 9.16421 7.58579 9.5 8 9.5C8.41421 9.5 8.75 9.16421 8.75 8.75V4.25C8.75 3.83579 8.41421 3.5 8 3.5Z"
                fill="url(#paint1_linear_1012_8647)"
              />
              <path
                d="M8 12.5C8.41421 12.5 8.75 12.1642 8.75 11.75C8.75 11.3358 8.41421 11 8 11C7.58579 11 7.25 11.3358 7.25 11.75C7.25 12.1642 7.58579 12.5 8 12.5Z"
                fill="url(#paint2_linear_1012_8647)"
              />
              <defs>
                <linearGradient
                  id="paint0_linear_1012_8647"
                  x1="0"
                  y1="8"
                  x2="16"
                  y2="8"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop stopColor="#901475" />
                  <stop offset="0.505208" stopColor="#CE2F55" />
                  <stop offset="1" stopColor="#FF6633" />
                </linearGradient>
                <linearGradient
                  id="paint1_linear_1012_8647"
                  x1="7.25"
                  y1="6.5"
                  x2="8.75"
                  y2="6.5"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop stopColor="#901475" />
                  <stop offset="0.505208" stopColor="#CE2F55" />
                  <stop offset="1" stopColor="#FF6633" />
                </linearGradient>
                <linearGradient
                  id="paint2_linear_1012_8647"
                  x1="7.25"
                  y1="11.75"
                  x2="8.75"
                  y2="11.75"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop stopColor="#901475" />
                  <stop offset="0.505208" stopColor="#CE2F55" />
                  <stop offset="1" stopColor="#FF6633" />
                </linearGradient>
              </defs>
            </svg>
          </a>
        </div>
        <button
          type="button"
          className="ml-auto rounded-md border border-gray-200 px-2 py-1 -mt-1"
          onClick={() => setShowSettings(!showSettings)}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 22 22"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <title>Settings</title>
            <path
              d="M11.0001 7.5625C10.3202 7.5625 9.65558 7.76411 9.09029 8.14182C8.52499 8.51954 8.0844 9.05641 7.82422 9.68453C7.56405 10.3126 7.49597 11.0038 7.62861 11.6706C7.76125 12.3374 8.08864 12.9499 8.56938 13.4307C9.05012 13.9114 9.66263 14.2388 10.3294 14.3714C10.9962 14.5041 11.6874 14.436 12.3155 14.1758C12.9437 13.9157 13.4805 13.4751 13.8582 12.9098C14.236 12.3445 14.4376 11.6799 14.4376 11C14.4376 10.0883 14.0754 9.21398 13.4307 8.56932C12.7861 7.92466 11.9117 7.5625 11.0001 7.5625ZM11.0001 13.0625C10.5921 13.0625 10.1934 12.9415 9.8542 12.7149C9.51502 12.4883 9.25066 12.1662 9.09456 11.7893C8.93845 11.4124 8.89761 10.9977 8.97719 10.5976C9.05677 10.1975 9.2532 9.83004 9.54165 9.54159C9.8301 9.25315 10.1976 9.05671 10.5977 8.97713C10.9978 8.89755 11.4125 8.93839 11.7893 9.0945C12.1662 9.2506 12.4883 9.51496 12.715 9.85414C12.9416 10.1933 13.0626 10.5921 13.0626 11C13.0626 11.547 12.8453 12.0716 12.4585 12.4584C12.0717 12.8452 11.5471 13.0625 11.0001 13.0625Z"
              fill="#797979"
            />
            <path
              d="M17.1532 11L19.7107 8.52844L17.4832 4.67156L14.1351 5.63062L13.2379 2.0625H8.76912L7.90631 5.63062L4.53756 4.67156L2.31006 8.53187L4.88131 11.0172L2.31006 13.5059L4.53756 17.3628L7.90631 16.4003L8.78287 19.9375H13.2516L14.1351 16.4106L17.5244 17.38L19.7554 13.5231L17.1532 11ZM16.8438 15.7472L13.8429 14.8844L12.9216 15.5203L12.1654 18.5625H9.85537L9.09912 15.5375L8.20881 14.8844L5.19068 15.7472L4.03568 13.75L6.28381 11.5775V10.4637L4.03568 8.28781L5.19068 6.28719L8.21225 7.15344L9.10256 6.44187L9.85537 3.4375H12.1654L12.9216 6.45563L13.8085 7.16719L16.8438 6.28719L17.9988 8.28781L15.7472 10.4637L15.7816 11.5741L18.0126 13.75L16.8438 15.7472Z"
              fill="#797979"
            />
          </svg>
        </button>
      </div>

      <p className="text-gray-400 text-sm mt-1 mb-4">
        Connect to Model Context Protocol (MCP) servers to access additional AI
        capabilities.
      </p>

      <div className="my-4">
        <div className="flex items-center mb-2">
          {/* biome-ignore lint/a11y/noLabelWithoutControl: eh */}
          <label className="font-semibold text-sm mr-2">Status:</label>
          {getStatusBadge()}
          {error && (
            <span className="ml-2 text-xs text-red-600 truncate max-w-[230px]">
              {error}
            </span>
          )}
        </div>

        <div className="flex space-x-2 mb-4">
          <input
            type="text"
            className="grow p-2 border border-gray-200 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-1 focus:ring-orange-300"
            placeholder="Enter MCP server URL"
            value={serverUrl}
            onChange={(e) => {
              const newValue = e.target.value;
              setServerUrl(newValue);
              sessionStorage.setItem("mcpServerUrl", newValue);
            }}
            disabled={isActive}
          />
          {isActive ? (
            <button
              type="button"
              className="px-3 py-2 bg-orange-100 hover:bg-orange-200 text-orange-900 rounded-md text-sm font-medium shadow-sm"
              onClick={handleDisconnect}
            >
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              className="bg-ai-loop bg-size-[200%_100%] hover:animate-gradient-background text-white rounded-md shadow-sm py-2 px-4 text-sm"
              onClick={handleConnect}
              disabled={isActive || isConnecting}
            >
              {isConnecting ? "Connecting..." : "Connect"}
            </button>
          )}
        </div>

        {/* Custom Authentication Section */}
        <div className="border border-gray-200 rounded-md bg-gray-50">
          <button
            className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-100 rounded-md transition-colors"
            onClick={() => setShowAuth(!showAuth)}
            type="button"
          >
            <div className="flex items-center space-x-2">
              <svg
                className="w-4 h-4 text-gray-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <title>Auth</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
              <span className="text-sm font-medium text-gray-700">
                Authentication (Optional)
              </span>
            </div>
            <svg
              className={`w-4 h-4 text-gray-500 transform transition-transform ${
                showAuth ? "rotate-180" : ""
              }`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <title>expand</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>

          {showAuth && (
            <div className="px-3 pb-3 space-y-3 border-t border-gray-200 bg-white rounded-b-md">
              <div>
                {/* biome-ignore lint/a11y/noLabelWithoutControl: eh */}
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Header Name
                </label>
                <input
                  type="text"
                  className="w-full p-2 border border-gray-200 rounded-md text-sm hover:bg-gray-50 focus:outline-none focus:ring-1 focus:ring-orange-300"
                  placeholder="e.g., Authorization, X-API-Key, API-Key"
                  value={headerKey}
                  onChange={(e) => {
                    const newValue = e.target.value;
                    setHeaderKey(newValue);
                    sessionStorage.setItem("mcpHeaderKey", newValue);
                  }}
                  disabled={isActive}
                />
              </div>

              <div>
                {/* biome-ignore lint/a11y/noLabelWithoutControl: eh */}
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Bearer Value
                </label>
                <div className="relative">
                  <input
                    type={showToken ? "text" : "password"}
                    className="w-full p-2 pr-10 border border-gray-200 rounded-md text-sm hover:bg-gray-50 focus:outline-none focus:ring-1 focus:ring-orange-300"
                    placeholder="Enter header value (API key, token, etc.)"
                    value={bearerToken}
                    onChange={(e) => {
                      const newValue = e.target.value;
                      setBearerToken(newValue);
                      sessionStorage.setItem("mcpBearerToken", newValue);
                    }}
                    disabled={isActive}
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 pr-3 flex items-center"
                    onClick={() => setShowToken(!showToken)}
                  >
                    <svg
                      className="w-4 h-4 text-gray-400 hover:text-gray-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <title>show token</title>
                      {showToken ? (
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21"
                        />
                      ) : (
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                        />
                      )}
                    </svg>
                  </button>
                </div>
              </div>

              {headerKey && bearerToken && (
                <div className="text-xs text-gray-500 flex items-start space-x-1">
                  <svg
                    className="w-3 h-3 mt-0.5 flex-shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <title>header</title>
                    <path
                      fillRule="evenodd"
                      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span>
                    Header will be sent as "{headerKey}: Bearer REDACTED"
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Debug Log - show MCP state transitions */}
        {showSettings && mcpLogs.length > 0 && (
          <div className="mt-4">
            <div className="font-semibold text-sm block mb-1">Debug Log</div>
            <div
              ref={logRef}
              className="border border-gray-200 rounded-md p-2 bg-gray-50 h-40 overflow-y-auto font-mono text-xs"
            >
              {mcpLogs.map((log) => {
                // Determine log level from status
                const level =
                  log.status === "failed"
                    ? "error"
                    : log.status === "ready"
                      ? "info"
                      : log.status === "connecting" ||
                          log.status === "discovering" ||
                          log.status === "authenticating"
                        ? "info"
                        : "debug";

                // Format timestamp
                const time = new Date(log.timestamp).toLocaleTimeString();

                // Create human-readable message
                const message = `${time} - Connection status: ${log.status}`;

                return (
                  <div
                    key={log.timestamp}
                    className={`py-0.5 ${
                      level === "debug"
                        ? "text-gray-500"
                        : level === "info"
                          ? "text-blue-600"
                          : "text-red-600"
                    }`}
                  >
                    [{level}] {message}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Display tools when connected */}
        {isActive &&
          mcpState?.tools &&
          Array.isArray(mcpState.tools) &&
          mcpState.tools.length > 0 && (
            <div className="mt-4 border border-green-200 rounded-md bg-green-50 p-3">
              <div className="text-sm font-medium text-green-900 mb-2">
                Available Tools ({mcpState.tools.length})
              </div>
              <div className="space-y-2 max-h-60 overflow-y-auto pr-2">
                {mcpState.tools.map((tool: Tool) => (
                  <div
                    key={tool.name}
                    className="bg-white rounded p-2 border border-green-200"
                  >
                    <div className="font-medium text-xs text-gray-900">
                      {tool.name.replace("tool_", "").replace(/_/g, " ")}
                    </div>
                    {tool.description && (
                      <div className="text-xs text-gray-600 mt-1">
                        {tool.description}
                      </div>
                    )}
                  </div>
                ))}
              </div>
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
