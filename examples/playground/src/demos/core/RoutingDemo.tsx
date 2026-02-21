import { useAgent } from "agents/react";
import { nanoid } from "nanoid";
import { useState, useEffect } from "react";
import { Button, Input, Surface, Text, Radio } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import {
  LogPanel,
  ConnectionStatus,
  CodeExplanation,
  type CodeSection
} from "../../components";
import { useLogs, useUserId } from "../../hooks";
import type { RoutingAgent, RoutingAgentState } from "./routing-agent";

const codeSections: CodeSection[] = [
  {
    title: "Route by agent name",
    description:
      "The name prop on useAgent determines which Durable Object instance you connect to. Same name = same agent. Use user IDs, session IDs, or fixed strings to control isolation.",
    code: `// Per-user: each user gets their own agent
const agent = useAgent({
  agent: "routing-agent",
  name: \`user-\${userId}\`,
});

// Shared: everyone on the same instance
const agent = useAgent({
  agent: "routing-agent",
  name: "shared",
});

// Per-session: each browser tab is isolated
const agent = useAgent({
  agent: "routing-agent",
  name: \`session-\${sessionId}\`,
});`
  },
  {
    title: "Custom routing with basePath",
    description:
      "For server-controlled routing, use basePath instead of name. Your Worker's fetch handler resolves the URL to the right Durable Object using getAgentByName().",
    code: `// Client: connect via a custom URL path
const agent = useAgent({
  agent: "routing-agent",
  basePath: \`custom-routing/\${userId}\`,
});

// Server: resolve the path in your Worker
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/custom-routing/")) {
      const name = url.pathname.split("/")[2];
      const agent = getAgentByName(env.RoutingAgent, name);
      return agent.fetch(request);
    }
  }
}`
  }
];

type RoutingStrategy = "per-user" | "shared" | "per-session" | "custom-path";

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
  const initialUserId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const [userId, setUserId] = useState(initialUserId);
  const [strategy, setStrategy] = useState<RoutingStrategy>("per-user");
  const [connectionCount, setConnectionCount] = useState(0);
  const [agentInstanceName, setAgentInstanceName] = useState<string>("");

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
    name: isCustomPath ? undefined : currentAgentName,
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
      description={
        <>
          The{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">name</code>{" "}
          prop on{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            useAgent
          </code>{" "}
          determines which Durable Object instance you connect to — same name
          means same agent. Use user IDs for per-user isolation, a fixed string
          for a shared singleton, or session IDs for per-tab agents. For
          server-controlled routing, use{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            basePath
          </code>{" "}
          instead. Switch strategies below and open multiple tabs to see the
          difference.
        </>
      }
      statusIndicator={
        <ConnectionStatus
          status={
            agent.readyState === WebSocket.OPEN ? "connected" : "connecting"
          }
        />
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Controls */}
        <div className="space-y-6">
          {/* Connection Status */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-kumo-subtle">Agent Instance:</span>
                <code className="bg-kumo-control px-2 py-0.5 rounded text-xs text-kumo-default">
                  {agentInstanceName || "connecting..."}
                </code>
              </div>
              <div className="flex justify-between">
                <span className="text-kumo-subtle">Counter:</span>
                <span className="font-bold text-lg text-kumo-default">
                  {connectionCount}
                </span>
              </div>
              <Button
                variant="secondary"
                onClick={() => agent.call("increment")}
                className="w-full"
              >
                Increment Counter
              </Button>
            </div>
          </Surface>

          {/* User Identity */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Your Identity</Text>
            </div>
            <div className="space-y-3">
              <Input
                label="User ID (persisted in localStorage)"
                type="text"
                value={userId}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setUserId(e.target.value)
                }
                className="w-full"
                placeholder="Enter a user ID"
              />
              <div>
                <span className="text-xs text-kumo-subtle block mb-1">
                  Session ID (auto-generated per tab)
                </span>
                <code className="block bg-kumo-control px-3 py-2 rounded text-sm text-kumo-default">
                  {getSessionId()}
                </code>
              </div>
            </div>
          </Surface>

          {/* Strategy Selector */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Routing Strategy</Text>
            </div>
            <Radio.Group
              legend="Routing Strategy"
              value={strategy}
              onValueChange={(value: string) => {
                setStrategy(value as RoutingStrategy);
                addLog("out", "strategy_change", value);
              }}
            >
              {strategies.map((s) => (
                <Radio.Item
                  key={s.id}
                  label={`${s.label} — ${s.description}`}
                  value={s.id}
                />
              ))}
            </Radio.Group>
          </Surface>

          {/* Multi-Tab Testing */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Try It Out</Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-4">
              Open multiple tabs to see how different strategies affect which
              clients end up on the same agent instance.
            </p>
            <Button variant="primary" onClick={openNewTab} className="w-full">
              Open New Tab
            </Button>
          </Surface>

          {/* Explanation */}
          <Surface className="p-4 rounded-lg bg-kumo-elevated">
            <div className="mb-3">
              <Text variant="heading3">How It Works</Text>
            </div>
            <div className="text-sm text-kumo-subtle space-y-2">
              <p>
                <strong className="text-kumo-default">Per-User:</strong> Agent
                name ={" "}
                <code className="text-kumo-default">routing-{userId}</code>
                <br />
                <span className="text-xs">
                  Same user across tabs/devices shares an agent
                </span>
              </p>
              <p>
                <strong className="text-kumo-default">Shared:</strong> Agent
                name = <code className="text-kumo-default">routing-shared</code>
                <br />
                <span className="text-xs">
                  Everyone connects to the same agent
                </span>
              </p>
              <p>
                <strong className="text-kumo-default">Per-Session:</strong>{" "}
                Agent name ={" "}
                <code className="text-kumo-default">
                  routing-{getSessionId()}
                </code>
                <br />
                <span className="text-xs">
                  Each browser tab gets its own agent
                </span>
              </p>
              <p>
                <strong className="text-kumo-default">Custom Path:</strong>{" "}
                basePath ={" "}
                <code className="text-kumo-default">
                  /custom-routing/routing-{userId}
                </code>
                <br />
                <span className="text-xs">
                  Server handles routing via{" "}
                  <code className="text-kumo-default">getAgentByName</code> —
                  client uses{" "}
                  <code className="text-kumo-default">basePath</code> instead of{" "}
                  <code className="text-kumo-default">agent</code>/
                  <code className="text-kumo-default">name</code>
                </span>
              </p>
            </div>
          </Surface>
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="600px" />
        </div>
      </div>

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
