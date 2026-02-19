import { useAgent } from "agents/react";
import { useState } from "react";
import { Button, Input, Surface, Empty, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { LogPanel, ConnectionStatus } from "../../components";
import { useLogs, useUserId } from "../../hooks";
import type {
  ConnectionsAgent,
  ConnectionsAgentState
} from "./connections-agent";

export function ConnectionsDemo() {
  const userId = useUserId();
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
    name: `connections-demo-${userId}`,
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
          );
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
          {/* Connection Count */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Connected Clients</Text>
            </div>
            <div className="text-4xl font-bold text-kumo-default mb-4">
              {connectionCount}
            </div>
            <p className="text-sm text-kumo-subtle mb-4">
              Open multiple tabs to see the count update in real-time
            </p>
            <Button variant="secondary" onClick={openNewTab}>
              Open New Tab
            </Button>
          </Surface>

          {/* Broadcast */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Broadcast Message</Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-3">
              Send a message to all connected clients (including yourself)
            </p>
            <div className="flex gap-2">
              <Input
                aria-label="Broadcast message"
                type="text"
                value={broadcastMessage}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setBroadcastMessage(e.target.value)
                }
                onKeyDown={(e: React.KeyboardEvent) =>
                  e.key === "Enter" && handleBroadcast()
                }
                className="flex-1"
                placeholder="Message to broadcast"
              />
              <Button variant="primary" onClick={handleBroadcast}>
                Broadcast
              </Button>
            </div>
          </Surface>

          {/* Received Messages */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Received Broadcasts</Text>
            </div>
            {receivedMessages.length === 0 ? (
              <Empty title="No messages received yet" size="sm" />
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {receivedMessages.map((msg, i) => (
                  <div
                    key={i}
                    className="py-2 px-3 bg-kumo-elevated rounded text-sm"
                  >
                    <div className="text-kumo-default">{msg.message}</div>
                    <div className="text-xs text-kumo-inactive">
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Surface>

          {/* Tips */}
          <Surface className="p-4 rounded-lg bg-kumo-elevated">
            <div className="mb-2">
              <Text variant="heading3">Try this:</Text>
            </div>
            <ol className="text-sm text-kumo-subtle space-y-1 list-decimal list-inside">
              <li>Open this page in another browser tab</li>
              <li>Watch the connection count update</li>
              <li>Send a broadcast message from one tab</li>
              <li>See it appear in all tabs</li>
            </ol>
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
