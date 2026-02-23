import { useAgent } from "agents/react";
import { useState } from "react";
import { Button, Input, Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import {
  LogPanel,
  ConnectionStatus,
  CodeExplanation,
  HighlightedJson,
  type CodeSection
} from "../../components";
import { useLogs, useUserId, useToast } from "../../hooks";
import type { StateAgent, StateAgentState } from "./state-agent";

const codeSections: CodeSection[] = [
  {
    title: "Define your agent with typed state",
    description:
      "Extend the Agent class with a state type. Set initialState and it will be automatically persisted — surviving restarts, hibernation, and reconnections.",
    code: `import { Agent, callable } from "agents";

interface StateAgentState {
  counter: number;
  items: string[];
  lastUpdated: string | null;
}

class StateAgent extends Agent<Env, StateAgentState> {
  initialState: StateAgentState = {
    counter: 0,
    items: [],
    lastUpdated: null,
  };
}`
  },
  {
    title: "Mutate state with @callable methods",
    description:
      "Methods decorated with @callable are exposed as RPC endpoints. Call this.setState() to update — the new state is automatically broadcast to every connected client.",
    code: `  @callable()
  increment(): StateAgentState {
    const newState = {
      ...this.state,
      counter: this.state.counter + 1,
      lastUpdated: new Date().toISOString(),
    };
    this.setState(newState);
    return newState;
  }`
  },
  {
    title: "Connect from React with useAgent",
    description:
      "The useAgent hook opens a WebSocket to your agent. The onStateUpdate callback fires whenever state changes — from this client, another client, or the server itself.",
    code: `import { useAgent } from "agents/react";

const agent = useAgent({
  agent: "state-agent",
  name: "my-instance",
  onStateUpdate: (newState, source) => {
    // source is "server" or "client"
    setState(newState);
  },
});

// Call server methods
await agent.call("increment");

// Or set state directly from the client
agent.setState({ ...state, counter: 42 });`
  }
];

export function StateDemo() {
  const userId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const { toast } = useToast();
  const [newItem, setNewItem] = useState("");
  const [customValue, setCustomValue] = useState("0");
  const [state, setState] = useState<StateAgentState>({
    counter: 0,
    items: [],
    lastUpdated: null
  });

  const agent = useAgent<StateAgent, StateAgentState>({
    agent: "state-agent",
    name: `state-demo-${userId}`,
    onStateUpdate: (newState, source) => {
      addLog("in", "state_update", { source, state: newState });
      if (newState) setState(newState);
    },
    onOpen: () => addLog("info", "connected"),
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error")
  });

  const handleIncrement = async () => {
    addLog("out", "call", "increment()");
    try {
      const result = await agent.call("increment");
      addLog("in", "result", result);
      toast("Counter: " + (result as StateAgentState).counter, "success");
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const handleDecrement = async () => {
    addLog("out", "call", "decrement()");
    try {
      const result = await agent.call("decrement");
      addLog("in", "result", result);
      toast("Counter: " + (result as StateAgentState).counter, "success");
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const handleSetCounter = async () => {
    const value = Number.parseInt(customValue, 10);
    addLog("out", "call", `setCounter(${value})`);
    try {
      const result = await agent.call("setCounter", [value]);
      addLog("in", "result", result);
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const handleAddItem = async () => {
    if (!newItem.trim()) return;
    addLog("out", "call", `addItem("${newItem}")`);
    try {
      const result = await agent.call("addItem", [newItem]);
      addLog("in", "result", result);
      setNewItem("");
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const handleRemoveItem = async (index: number) => {
    addLog("out", "call", `removeItem(${index})`);
    try {
      const result = await agent.call("removeItem", [index]);
      addLog("in", "result", result);
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const handleReset = async () => {
    addLog("out", "call", "resetState()");
    try {
      const result = await agent.call("resetState");
      addLog("in", "result", result);
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const handleClientSetState = () => {
    const value = Number.parseInt(customValue, 10);
    addLog("out", "setState", { counter: value });
    agent.setState({
      ...state,
      counter: value,
      lastUpdated: new Date().toISOString()
    });
  };

  return (
    <DemoWrapper
      title="State Management"
      description={
        <>
          Every agent has a{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            state
          </code>{" "}
          object that is automatically persisted and synchronized. When you call{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            this.setState()
          </code>{" "}
          on the server, every connected client receives the update instantly
          over WebSocket. Clients can also set state directly — changes flow
          both ways. State survives restarts, hibernation, and reconnections.
          Try incrementing the counter, then refresh the page.
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
          {/* Counter Controls */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Counter: {state.counter}</Text>
            </div>
            <div className="flex gap-2 mb-4">
              <Button variant="secondary" onClick={handleDecrement}>
                -1
              </Button>
              <Button variant="primary" onClick={handleIncrement}>
                +1
              </Button>
            </div>
            <Input
              aria-label="Custom counter value"
              type="number"
              value={customValue}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setCustomValue(e.target.value)
              }
              className="w-full mb-2"
              placeholder="Custom value"
            />
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={handleSetCounter}
                className="flex-1"
              >
                Set (Server)
              </Button>
              <Button
                variant="secondary"
                onClick={handleClientSetState}
                className="flex-1"
              >
                Set (Client)
              </Button>
            </div>
          </Surface>

          {/* Items List */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Items ({state.items.length})</Text>
            </div>
            <div className="flex gap-2 mb-4">
              <Input
                aria-label="New item"
                type="text"
                value={newItem}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setNewItem(e.target.value)
                }
                onKeyDown={(e: React.KeyboardEvent) =>
                  e.key === "Enter" && handleAddItem()
                }
                className="flex-1"
                placeholder="New item"
              />
              <Button variant="primary" onClick={handleAddItem}>
                Add
              </Button>
            </div>
            {state.items.length > 0 ? (
              <ul className="space-y-1">
                {state.items.map((item: string, i: number) => (
                  <li
                    key={i}
                    className="flex items-center justify-between py-1 px-2 bg-kumo-elevated rounded"
                  >
                    <span className="text-sm text-kumo-default">{item}</span>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => handleRemoveItem(i)}
                      className="text-kumo-danger"
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-kumo-inactive">No items</p>
            )}
          </Surface>

          {/* State Display */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="flex items-center justify-between mb-2">
              <Text variant="heading3">Current State</Text>
              <Button variant="destructive" size="xs" onClick={handleReset}>
                Reset
              </Button>
            </div>
            <HighlightedJson data={state} />
            {state.lastUpdated && (
              <p className="text-xs text-kumo-inactive mt-2">
                Last updated: {new Date(state.lastUpdated).toLocaleString()}
              </p>
            )}
          </Surface>
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="400px" />
        </div>
      </div>

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
