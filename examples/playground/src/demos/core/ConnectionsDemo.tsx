import { useAgent } from "agents/react";
import { useState } from "react";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs } from "../../hooks";
import type {
  ConnectionsAgent,
  ConnectionsAgentState
} from "./connections-agent";

export function ConnectionsDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const [connectionCount, setConnectionCount] = useState(0);
  const [broadcastMessage, setBroadcastMessage] = useState(
    "Hello from the playground!"
  );
  const [receivedMessages, setReceivedMessages] = useState<
    Array<{ message: string; timestamp: number }>
  >([]);

  const agent = useAgent<ConnectionsAgent, ConnectionsAgentState>({
    agent: "connections-agent",
    name: "connections-demo",
    onOpen: () => {
      addLog("info", "connected");
      refreshConnectionCount();
    },
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error"),
    onMessage: (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === "connection_count") {
          setConnectionCount(data.count);
          addLog("in", "connection_count", data.count);
        } else if (data.type === "broadcast") {
          addLog("in", "broadcast", data.message);
          setReceivedMessages((prev) =>
            [
              ...prev,
              { message: data.message, timestamp: data.timestamp }
            ].slice(-10)
          ); // Keep last 10
        }
      } catch {
        // Not JSON
      }
    }
  });

  const refreshConnectionCount = async () => {
    try {
      const count = await agent.call("getConnectionCount");
      setConnectionCount(count);
    } catch {
      // Ignore
    }
  };

  const handleBroadcast = async () => {
    if (!broadcastMessage.trim()) return;
    addLog("out", "broadcastMessage", broadcastMessage);
    try {
      await agent.call("broadcastMessage", [broadcastMessage]);
      addLog("in", "broadcast_sent");
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const openNewTab = () => {
    window.open(window.location.href, "_blank");
  };

  return (
    <DemoWrapper
      title="Connections"
      description="Manage WebSocket connections, track clients, and broadcast messages to all connected clients."
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

          {/* Connection Count */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Connected Clients</h3>
            <div className="text-4xl font-bold mb-4">{connectionCount}</div>
            <p className="text-sm text-neutral-600 mb-4">
              Open multiple tabs to see the count update in real-time
            </p>
            <button
              type="button"
              onClick={openNewTab}
              className="btn btn-secondary"
            >
              Open New Tab
            </button>
          </div>

          {/* Broadcast */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Broadcast Message</h3>
            <p className="text-sm text-neutral-600 mb-3">
              Send a message to all connected clients (including yourself)
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={broadcastMessage}
                onChange={(e) => setBroadcastMessage(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleBroadcast()}
                className="input flex-1"
                placeholder="Message to broadcast"
              />
              <button
                type="button"
                onClick={handleBroadcast}
                className="btn btn-primary"
              >
                Broadcast
              </button>
            </div>
          </div>

          {/* Received Messages */}
          <div className="card p-4">
            <h3 className="font-semibold mb-4">Received Broadcasts</h3>
            {receivedMessages.length === 0 ? (
              <p className="text-sm text-neutral-400">
                No messages received yet
              </p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {receivedMessages.map((msg, i) => (
                  <div
                    key={i}
                    className="py-2 px-3 bg-neutral-50 dark:bg-neutral-800 rounded text-sm"
                  >
                    <div>{msg.message}</div>
                    <div className="text-xs text-neutral-400">
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Tips */}
          <div className="card p-4 bg-neutral-50 dark:bg-neutral-800">
            <h3 className="font-semibold mb-2">Try this:</h3>
            <ol className="text-sm text-neutral-600 space-y-1 list-decimal list-inside">
              <li>Open this page in another browser tab</li>
              <li>Watch the connection count update</li>
              <li>Send a broadcast message from one tab</li>
              <li>See it appear in all tabs</li>
            </ol>
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
