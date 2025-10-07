import { DisksSection } from "./DisksSection";
import { ChatSection } from "./ChatSection";
import type { Disk, Message } from "../types";

interface AgentBoxProps {
  agentName: string;
  disks: Disk[];
  messages: Message[];
  agentBase: string;
  onSendMessage: (content: string) => Promise<void>;
  onNewChat: () => void;
  isLoading: boolean;
}

export function AgentBox({
  agentName,
  disks,
  messages,
  agentBase,
  onSendMessage,
  onNewChat,
  isLoading
}: AgentBoxProps) {
  return (
    <div box-="square" shear-="top">
      <div className="header">
        <span is-="badge" variant-="background0">
          Agent
        </span>
        <span is-="badge" variant-="background0">
          {agentName}
        </span>
      </div>

      <DisksSection agentBase={agentBase} disks={disks} />

      <div style={{ width: "100%", marginBottom: "-0.5lh" }} is-="separator" />
      <ChatSection
        messages={messages}
        onSendMessage={onSendMessage}
        onNewChat={onNewChat}
        isLoading={isLoading}
      />
    </div>
  );
}
