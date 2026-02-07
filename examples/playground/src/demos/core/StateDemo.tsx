import { useAgent } from "agents/react";
import { useState } from "react";
import { Button, Input, Surface, CodeBlock, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs } from "../../hooks";
import type { StateAgent, StateAgentState } from "./state-agent";

export function StateDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [newItem, setNewItem] = useState("");
  const [customValue, setCustomValue] = useState("0");
  const [state, setState] = useState<StateAgentState>({
    counter: 0,
    items: [],
    lastUpdated: null
  });

  const agent = useAgent<StateAgent, StateAgentState>({
    agent: "state-agent",
    name: "state-demo",
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
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleDecrement = async () => {
    addLog("out", "call", "decrement()");
    try {
      const result = await agent.call("decrement");
      addLog("in", "result", result);
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
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
    }
  };

  const handleRemoveItem = async (index: number) => {
    addLog("out", "call", `removeItem(${index})`);
    try {
      const result = await agent.call("removeItem", [index]);
      addLog("in", "result", result);
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleReset = async () => {
    addLog("out", "call", "resetState()");
    try {
      const result = await agent.call("resetState");
      addLog("in", "result", result);
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
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
      description="Real-time state synchronization between server and clients. State persists across reconnections."
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
            <div className="flex gap-2">
              <Input
                aria-label="Custom counter value"
                type="number"
                value={customValue}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setCustomValue(e.target.value)
                }
                className="flex-1"
                placeholder="Custom value"
              />
              <Button variant="secondary" onClick={handleSetCounter}>
                Set (Server)
              </Button>
              <Button variant="secondary" onClick={handleClientSetState}>
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
            <CodeBlock code={JSON.stringify(state, null, 2)} lang="jsonc" />
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
    </DemoWrapper>
  );
}
