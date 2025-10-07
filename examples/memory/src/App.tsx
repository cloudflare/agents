import { useState, useCallback, useEffect } from "react";
import { ConnectBox } from "./components/ConnectBox";
import { AgentBox } from "./components/AgentBox";
import { useChat } from "./hooks/useChat";
import { useAgentName } from "./hooks/useAgentName";
import { useAgent } from "agents/react";
import "./styles.css";
import type {
  Disk,
  DiskSearchNotification,
  DiskAddNotification
} from "./types";

export default function App() {
  const [agentName, setAgentName] = useAgentName();
  const [disks, setDisks] = useState<Disk[]>([]);

  const { messages, sendMessage, clearChat, isLoading, addSystemMessage } =
    useChat(agentName);

  const agent = useAgent({
    agent: "agent",
    name: agentName,
    startClosed: true,
    onMessage: (message) => {
      try {
        const json = JSON.parse(message.data);
        if (json.type === "cf_agent_disks" && json.disks) {
          setDisks(json.disks);
        } else if (json.type === "disk_search") {
          const notification: DiskSearchNotification = json;
          addSystemMessage(
            `🔍 Searching "${notification.diskName}" for: "${notification.query}"`
          );
        } else if (json.type === "disk_add") {
          const notification: DiskAddNotification = json;
          addSystemMessage(`💾 Added entry to disk "${notification.diskName}"`);
        }
      } catch (e) {
        console.error("Error parsing WebSocket message:", e);
      }
    }
  });

  useEffect(() => {
    if (agentName) {
      agent.reconnect();
    }
  }, [agentName, agent.reconnect]);

  const handleConnect = useCallback(
    (agentName: string) => {
      setAgentName(agentName);
    },
    [setAgentName]
  );

  const handleSendMessage = useCallback(
    async (content: string) => {
      const agentBase = `/agents/agent/${encodeURIComponent(agentName)}`;
      await sendMessage(agentBase, content);
    },
    [agentName, sendMessage]
  );

  const agentBase = agentName
    ? `/agents/agent/${encodeURIComponent(agentName)}`
    : "";

  return (
    <>
      <ConnectBox
        onConnect={handleConnect}
        status={agent.readyState === agent.OPEN ? "Connected" : "Disconnected"}
        initialAgentName={agentName}
      />
      {agent.readyState === agent.OPEN && (
        <AgentBox
          agentName={agentName}
          disks={disks}
          messages={messages}
          agentBase={agentBase}
          onSendMessage={handleSendMessage}
          onNewChat={clearChat}
          isLoading={isLoading}
        />
      )}
    </>
  );
}
