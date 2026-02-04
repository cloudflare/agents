import { useAgent } from "agents/react";
import { nanoid } from "nanoid";
import { useState, useEffect } from "react";
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

  // Auto-refresh on connect
  useEffect(() => {
    if (agent.readyState === WebSocket.OPEN) {
      refreshStats();
    }
  }, [agent.readyState]);

  return (
    <DemoWrapper
      title="Supervisor Pattern"
      description="A supervisor agent manages multiple child agents using getAgentByName for Durable Object RPC."
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Controls */}
        <div className="space-y-6">
          {/* Connection & Stats */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Supervisor</h3>
              <ConnectionStatus
                status={
                  agent.readyState === WebSocket.OPEN
                    ? "connected"
                    : "connecting"
                }
              />
            </div>

            {/* Stats Bar */}
            <div className="flex gap-4 text-sm mb-4">
              <div className="flex-1 bg-neutral-100 dark:bg-neutral-800 rounded p-3 text-center">
                <div className="text-2xl font-bold">{stats.totalChildren}</div>
                <div className="text-neutral-500 dark:text-neutral-400 text-xs">
                  Children
                </div>
              </div>
              <div className="flex-1 bg-neutral-100 dark:bg-neutral-800 rounded p-3 text-center">
                <div className="text-2xl font-bold">{stats.totalCounter}</div>
                <div className="text-neutral-500 dark:text-neutral-400 text-xs">
                  Total Counter
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleCreateChild}
                className="btn btn-primary flex-1"
              >
                + Create Child
              </button>
              <button
                type="button"
                onClick={handleIncrementAll}
                className="btn btn-secondary flex-1"
                disabled={children.length === 0}
              >
                +1 to All
              </button>
            </div>
          </div>

          {/* Children Grid */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">
                Child Agents ({children.length})
              </h3>
              {children.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="text-xs text-red-600 hover:text-red-800"
                >
                  Clear All
                </button>
              )}
            </div>

            {children.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {children.map((child) => (
                  <div
                    key={child.id}
                    className="border border-neutral-200 dark:border-neutral-700 rounded p-3"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <code className="text-xs text-neutral-500 dark:text-neutral-400">
                        {child.id}
                      </code>
                      <button
                        type="button"
                        onClick={() => handleRemoveChild(child.id)}
                        className="text-xs text-red-600 hover:text-red-800"
                      >
                        ×
                      </button>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-2xl font-bold">
                        {child.state.counter}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleIncrementChild(child.id)}
                        className="btn btn-secondary text-sm py-1 px-3"
                      >
                        +1
                      </button>
                    </div>
                    {child.state.createdAt && (
                      <div className="text-xs text-neutral-400 mt-2">
                        {new Date(child.state.createdAt).toLocaleTimeString()}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-neutral-400 text-center py-8">
                No children yet. Click "Create Child" to spawn a new child
                agent.
              </p>
            )}
          </div>

          {/* How it Works */}
          <div className="card p-4 bg-neutral-50 dark:bg-neutral-800">
            <h3 className="font-semibold mb-2">How it Works</h3>
            <ul className="text-sm text-neutral-600 dark:text-neutral-300 space-y-1">
              <li>
                • The{" "}
                <code className="text-xs bg-neutral-200 dark:bg-neutral-700 px-1 rounded">
                  SupervisorAgent
                </code>{" "}
                creates child agents using{" "}
                <code className="text-xs bg-neutral-200 dark:bg-neutral-700 px-1 rounded">
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
