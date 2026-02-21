import { useAgent } from "agents/react";
import { nanoid } from "nanoid";
import { useState, useEffect, useCallback } from "react";
import { Button, Surface, Empty, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import {
  LogPanel,
  ConnectionStatus,
  CodeExplanation,
  type CodeSection
} from "../../components";
import { useLogs, useUserId } from "../../hooks";
import type { ChildState } from "./child-agent";
import type { SupervisorAgent, SupervisorState } from "./supervisor-agent";

interface ChildInfo {
  id: string;
  state: ChildState;
}

const codeSections: CodeSection[] = [
  {
    title: "Spawn child agents with getAgentByName",
    description:
      "The supervisor creates child agents by calling getAgentByName(). Each child is a separate Durable Object with its own state and lifecycle.",
    code: `import { Agent, callable, getAgentByName } from "agents";

class SupervisorAgent extends Agent<Env> {
  @callable()
  async createChild(childId: string) {
    const child = await getAgentByName(this.env.ChildAgent, childId);
    await child.initialize({ createdBy: this.name });
    return { id: childId, status: "created" };
  }
}`
  },
  {
    title: "Coordinate across children",
    description:
      "The supervisor can call methods on any child via Durable Object RPC. Fan out to all children with Promise.all() for parallel operations.",
    code: `  @callable()
  async incrementAll() {
    const results = await Promise.all(
      this.state.childIds.map(async (id) => {
        const child = await getAgentByName(this.env.ChildAgent, id);
        return child.increment();
      })
    );
    return { updated: results.length };
  }`
  }
];

export function SupervisorDemo() {
  const userId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const [children, setChildren] = useState<ChildInfo[]>([]);
  const [stats, setStats] = useState({ totalChildren: 0, totalCounter: 0 });

  const agent = useAgent<SupervisorAgent, SupervisorState>({
    agent: "supervisor-agent",
    name: `demo-supervisor-${userId}`,
    onOpen: () => {
      addLog("info", "connected");
      refreshStats();
    },
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error")
  });

  const refreshStats = useCallback(async () => {
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
  }, [agent, addLog]);

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
  }, [agent.readyState, refreshStats]);

  return (
    <DemoWrapper
      title="Supervisor Pattern"
      description={
        <>
          A supervisor agent creates and manages child agents using{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            getAgentByName()
          </code>
          . Each child is a separate Durable Object with its own state and
          lifecycle. The supervisor coordinates them via Durable Object RPC —
          calling methods, aggregating results, and tracking their state. Create
          a few children below and increment them individually or all at once.
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
                        aria-label="Remove child agent"
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

          <CodeExplanation sections={codeSections} />
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="600px" />
        </div>
      </div>
    </DemoWrapper>
  );
}
