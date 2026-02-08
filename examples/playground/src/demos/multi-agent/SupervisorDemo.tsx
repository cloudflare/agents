import { useAgent } from "agents/react";
import { nanoid } from "nanoid";
import { useState, useEffect } from "react";
import { Button, Surface, Empty, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs } from "../../hooks";
import type { ChildState } from "./child-agent";
import type { SupervisorAgent, SupervisorState } from "./supervisor-agent";

interface ChildInfo {
  id: string;
  state: ChildState;
}

export function SupervisorDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [children, setChildren] = useState<ChildInfo[]>([]);
  const [stats, setStats] = useState({ totalChildren: 0, totalCounter: 0 });

  const agent = useAgent<SupervisorAgent, SupervisorState>({
    agent: "supervisor-agent",
    name: "demo-supervisor",
    onOpen: () => {
      addLog("info", "connected");
      refreshStats();
    },
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error")
  });

  const refreshStats = async () => {
    try {
      const result = await agent.call("getStats");
      setChildren(result.children);
      setStats({
        totalChildren: result.totalChildren,
        totalCounter: result.totalCounter
      });
      addLog("in", "stats", result);
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleCreateChild = async () => {
    const childId = `child-${nanoid(6)}`;
    addLog("out", "call", `createChild("${childId}")`);
    try {
      const result = await agent.call("createChild", [childId]);
      addLog("in", "result", result);
      await refreshStats();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleIncrementChild = async (childId: string) => {
    addLog("out", "call", `incrementChild("${childId}")`);
    try {
      const result = await agent.call("incrementChild", [childId]);
      addLog("in", "result", result);
      await refreshStats();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleIncrementAll = async () => {
    addLog("out", "call", "incrementAll()");
    try {
      const result = await agent.call("incrementAll");
      addLog("in", "result", result);
      await refreshStats();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleRemoveChild = async (childId: string) => {
    addLog("out", "call", `removeChild("${childId}")`);
    try {
      await agent.call("removeChild", [childId]);
      await refreshStats();
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleClearAll = async () => {
    addLog("out", "call", "clearChildren()");
    try {
      await agent.call("clearChildren");
      setChildren([]);
      setStats({ totalChildren: 0, totalCounter: 0 });
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (agent.readyState === WebSocket.OPEN) {
      refreshStats();
    }
  }, [agent.readyState]);

  return (
    <DemoWrapper
      title="Supervisor Pattern"
      description="A supervisor agent manages multiple child agents using getAgentByName for Durable Object RPC."
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
          {/* Connection & Stats */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            {/* Stats Bar */}
            <div className="flex gap-4 text-sm mb-4">
              <div className="flex-1 bg-kumo-control rounded p-3 text-center">
                <div className="text-2xl font-bold text-kumo-default">
                  {stats.totalChildren}
                </div>
                <div className="text-kumo-subtle text-xs">Children</div>
              </div>
              <div className="flex-1 bg-kumo-control rounded p-3 text-center">
                <div className="text-2xl font-bold text-kumo-default">
                  {stats.totalCounter}
                </div>
                <div className="text-kumo-subtle text-xs">Total Counter</div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <Button variant="primary" onClick={handleCreateChild}>
                + Create Child
              </Button>
              <Button
                variant="secondary"
                onClick={handleIncrementAll}
                disabled={children.length === 0}
              >
                +1 to All
              </Button>
            </div>
          </Surface>

          {/* Children Grid */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="flex items-center justify-between mb-4">
              <Text variant="heading3">Child Agents ({children.length})</Text>
              {children.length > 0 && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handleClearAll}
                  className="text-kumo-danger"
                >
                  Clear All
                </Button>
              )}
            </div>

            {children.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {children.map((child) => (
                  <div
                    key={child.id}
                    className="border border-kumo-line rounded p-3"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <code className="text-xs text-kumo-subtle">
                        {child.id}
                      </code>
                      <Button
                        variant="ghost"
                        shape="square"
                        size="xs"
                        onClick={() => handleRemoveChild(child.id)}
                        className="text-kumo-danger"
                      >
                        ×
                      </Button>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-2xl font-bold text-kumo-default">
                        {child.state.counter}
                      </span>
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => handleIncrementChild(child.id)}
                      >
                        +1
                      </Button>
                    </div>
                    {child.state.createdAt && (
                      <div className="text-xs text-kumo-inactive mt-2">
                        {new Date(child.state.createdAt).toLocaleTimeString()}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                title='No children yet. Click "Create Child" to spawn a new child agent.'
                size="sm"
              />
            )}
          </Surface>

          {/* How it Works */}
          <Surface className="p-4 rounded-lg bg-kumo-elevated">
            <div className="mb-2">
              <Text variant="heading3">How it Works</Text>
            </div>
            <ul className="text-sm text-kumo-subtle space-y-1">
              <li>
                • The{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  SupervisorAgent
                </code>{" "}
                creates child agents using{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  getAgentByName()
                </code>
              </li>
              <li>
                • Each child is a separate Durable Object with its own state
              </li>
              <li>
                • The supervisor calls child methods via Durable Object RPC
              </li>
              <li>
                • Children are tracked by ID and can be managed individually
              </li>
            </ul>
          </Surface>
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="600px" />
        </div>
      </div>
    </DemoWrapper>
  );
}
