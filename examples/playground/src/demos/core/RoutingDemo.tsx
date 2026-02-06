import { useAgent } from "agents/react";
import { nanoid } from "nanoid";
import { useState, useEffect } from "react";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs } from "../../hooks";
import type { RoutingAgent, RoutingAgentState } from "./routing-agent";

type RoutingStrategy = "per-user" | "shared" | "per-session" | "custom-path";

function getStoredUserId(): string {
  if (typeof window === "undefined") return "user-1";
  const stored = localStorage.getItem("playground-user-id");
  if (stored) return stored;
  const newId = `user-${nanoid(6)}`;
  localStorage.setItem("playground-user-id", newId);
  return newId;
}

function getSessionId(): string {
  if (typeof window === "undefined") return "session-1";
  let sessionId = sessionStorage.getItem("playground-session-id");
  if (!sessionId) {
    sessionId = `session-${nanoid(6)}`;
    sessionStorage.setItem("playground-session-id", sessionId);
  }
  return sessionId;
}

export function RoutingDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [userId, setUserId] = useState(getStoredUserId);
  const [strategy, setStrategy] = useState<RoutingStrategy>("per-user");
  const [connectionCount, setConnectionCount] = useState(0);
  const [agentInstanceName, setAgentInstanceName] = useState<string>("");

  // Compute the agent instance name based on strategy
  const getAgentName = () => {
    switch (strategy) {
      case "per-user":
        return `routing-${userId}`;
      case "shared":
        return "routing-shared";
      case "per-session":
        return `routing-${getSessionId()}`;
      case "custom-path":
        return `routing-${userId}`;
      default:
        return "routing-demo";
    }
  };

  const currentAgentName = getAgentName();
  const isCustomPath = strategy === "custom-path";

  const agent = useAgent<RoutingAgent, RoutingAgentState>({
    agent: "routing-agent",
    // When using basePath, the server handles routing — name is ignored
    name: isCustomPath ? undefined : currentAgentName,
    // basePath bypasses the default /agents/{agent}/{name} URL construction
    // and connects directly to this path, where the server routes to the agent.
    // Note: basePath should NOT start with a slash (the URL already includes one).
    basePath: isCustomPath ? `custom-routing/${currentAgentName}` : undefined,
    onOpen: () => {
      if (!isCustomPath) {
        addLog("info", "connected", `Agent: ${currentAgentName}`);
        setAgentInstanceName(currentAgentName);
      } else {
        addLog(
          "info",
          "connected",
          `Custom path: /custom-routing/${currentAgentName}`
        );
      }
    },
    onIdentity: (name, agentType) => {
      // When using basePath, the server sends the identity after connection
      addLog("info", "identity", `Server resolved: ${agentType}/${name}`);
      setAgentInstanceName(name);
    },
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error"),
    onStateUpdate: (newState) => {
      setConnectionCount(newState.counter);
      addLog("in", "state_update", { counter: newState.counter });
    }
  });

  // Save userId to localStorage when it changes
  useEffect(() => {
    localStorage.setItem("playground-user-id", userId);
  }, [userId]);

  const openNewTab = () => {
    window.open(window.location.href, "_blank");
  };

  const strategies: {
    id: RoutingStrategy;
    label: string;
    description: string;
  }[] = [
    {
      id: "per-user",
      label: "Per-User",
      description: "Each user ID gets their own agent instance"
    },
    {
      id: "shared",
      label: "Shared",
      description: "All users share a single agent instance"
    },
    {
      id: "per-session",
      label: "Per-Session",
      description: "Each browser session gets its own agent"
    },
    {
      id: "custom-path",
      label: "Custom Path (basePath)",
      description:
        "Server-side routing via a custom URL path using getAgentByName"
    }
  ];

  return (
    <DemoWrapper
      title="Routing Strategies"
      description="Different agent routing patterns for different use cases. Use 'name' to select an agent instance, or 'basePath' to route via a custom server-side path."
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Controls */}
        <div className="space-y-6">
          {/* Connection Status */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Connection</h3>
              <ConnectionStatus
                status={
                  agent.readyState === WebSocket.OPEN
                    ? "connected"
                    : "connecting"
                }
              />
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-500 dark:text-neutral-400">
                  Agent Instance:
                </span>
                <code className="bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 rounded text-xs">
                  {agentInstanceName || "connecting..."}
                </code>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500 dark:text-neutral-400">
                  Counter:
                </span>
                <span className="font-bold text-lg">{connectionCount}</span>
              </div>
              <button
                type="button"
                onClick={() => agent.call("increment")}
                className="btn-secondary w-full text-sm"
              >
                Increment Counter
              </button>
            </div>
          </div>

          {/* User Identity */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Your Identity</h3>
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="user-id"
                  className="text-xs text-neutral-500 dark:text-neutral-400 block mb-1"
                >
                  User ID (persisted in localStorage)
                </label>
                <input
                  id="user-id"
                  type="text"
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  className="input w-full"
                  placeholder="Enter a user ID"
                />
              </div>
              <div>
                <span className="text-xs text-neutral-500 dark:text-neutral-400 block mb-1">
                  Session ID (auto-generated per tab)
                </span>
                <code className="block bg-neutral-100 dark:bg-neutral-800 px-3 py-2 rounded text-sm">
                  {getSessionId()}
                </code>
              </div>
            </div>
          </div>

          {/* Strategy Selector */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Routing Strategy</h3>
            <div className="space-y-2">
              {strategies.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setStrategy(s.id);
                    addLog("out", "strategy_change", s.id);
                  }}
                  className={`w-full text-left p-3 rounded-lg border transition-colors ${
                    strategy === s.id
                      ? "border-black dark:border-white bg-neutral-50 dark:bg-neutral-800"
                      : "border-neutral-200 dark:border-neutral-700 hover:border-neutral-400 dark:hover:border-neutral-500"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-3 h-3 rounded-full border-2 ${
                        strategy === s.id
                          ? "border-black dark:border-white bg-black dark:bg-white"
                          : "border-neutral-300 dark:border-neutral-600"
                      }`}
                    />
                    <span className="font-medium">{s.label}</span>
                  </div>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 ml-5">
                    {s.description}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* Multi-Tab Testing */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Try It Out</h3>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
              Open multiple tabs to see how different strategies affect which
              clients end up on the same agent instance.
            </p>
            <button
              type="button"
              onClick={openNewTab}
              className="btn btn-primary w-full"
            >
              Open New Tab
            </button>
          </div>

          {/* Explanation */}
          <div className="card p-4 bg-neutral-50 dark:bg-neutral-800">
            <h3 className="font-semibold mb-3">How It Works</h3>
            <div className="text-sm text-neutral-600 dark:text-neutral-400 space-y-2">
              <p>
                <strong>Per-User:</strong> Agent name ={" "}
                <code>routing-{userId}</code>
                <br />
                <span className="text-xs">
                  Same user across tabs/devices shares an agent
                </span>
              </p>
              <p>
                <strong>Shared:</strong> Agent name ={" "}
                <code>routing-shared</code>
                <br />
                <span className="text-xs">
                  Everyone connects to the same agent
                </span>
              </p>
              <p>
                <strong>Per-Session:</strong> Agent name ={" "}
                <code>routing-{getSessionId()}</code>
                <br />
                <span className="text-xs">
                  Each browser tab gets its own agent
                </span>
              </p>
              <p>
                <strong>Custom Path:</strong> basePath ={" "}
                <code>/custom-routing/routing-{userId}</code>
                <br />
                <span className="text-xs">
                  Server handles routing via <code>getAgentByName</code> —
                  client uses <code>basePath</code> instead of{" "}
                  <code>agent</code>/<code>name</code>
                </span>
              </p>
            </div>
          </div>
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="600px" />
        </div>
      </div>
    </DemoWrapper>
  );
}
