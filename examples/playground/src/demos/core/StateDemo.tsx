import { useAgent } from "agents/react";
import { useState } from "react";
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
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Controls */}
        <div className="space-y-6">
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
          </div>

          {/* Counter Controls */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Counter: {state.counter}</h3>
            <div className="flex gap-2 mb-4">
              <button
                type="button"
                onClick={handleDecrement}
                className="btn btn-secondary flex-1"
              >
                -1
              </button>
              <button
                type="button"
                onClick={handleIncrement}
                className="btn btn-primary flex-1"
              >
                +1
              </button>
            </div>
            <div className="flex gap-2">
              <input
                type="number"
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
                className="input flex-1"
                placeholder="Custom value"
              />
              <button
                type="button"
                onClick={handleSetCounter}
                className="btn btn-secondary"
              >
                Set (Server)
              </button>
              <button
                type="button"
                onClick={handleClientSetState}
                className="btn btn-secondary"
              >
                Set (Client)
              </button>
            </div>
          </div>

          {/* Items List */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Items ({state.items.length})</h3>
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={newItem}
                onChange={(e) => setNewItem(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddItem()}
                className="input flex-1"
                placeholder="New item"
              />
              <button
                type="button"
                onClick={handleAddItem}
                className="btn btn-primary"
              >
                Add
              </button>
            </div>
            {state.items.length > 0 ? (
              <ul className="space-y-1">
                {state.items.map((item: string, i: number) => (
                  <li
                    key={i}
                    className="flex items-center justify-between py-1 px-2 bg-neutral-50 dark:bg-neutral-800 rounded"
                  >
                    <span className="text-sm">{item}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveItem(i)}
                      className="text-xs text-red-600 hover:text-red-800"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-neutral-400">No items</p>
            )}
          </div>

          {/* State Display */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">Current State</h3>
              <button
                type="button"
                onClick={handleReset}
                className="btn btn-danger text-xs py-1 px-2"
              >
                Reset
              </button>
            </div>
            <pre className="text-xs bg-neutral-50 dark:bg-neutral-900 p-3 rounded overflow-x-auto">
              {JSON.stringify(state, null, 2)}
            </pre>
            {state.lastUpdated && (
              <p className="text-xs text-neutral-400 mt-2">
                Last updated: {new Date(state.lastUpdated).toLocaleString()}
              </p>
            )}
          </div>
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="400px" />
        </div>
      </div>
    </DemoWrapper>
  );
}
