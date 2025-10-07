import { useState, useRef, useEffect } from "react";
import { ChatMessage } from "./ChatMessage";
import type { Message } from "../types";

interface ChatSectionProps {
  messages: Message[];
  onSendMessage: (content: string) => Promise<void>;
  onNewChat: () => void;
  isLoading: boolean;
}

export function ChatSection({
  messages,
  onSendMessage,
  onNewChat,
  isLoading
}: ChatSectionProps) {
  const [messageInput, setMessageInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dont care
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!messageInput.trim() || isLoading) return;

    const content = messageInput.trim();
    setMessageInput("");
    await onSendMessage(content);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !isLoading) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1lh",
          width: "100%",
          height: "50vh",
          overflow: "auto",
          padding: "0 1ch 1lh 1ch"
        }}
      >
        {messages.map((msg, index) => (
          <ChatMessage key={String(index)} message={msg} />
        ))}
        {isLoading && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "1ch",
              color: "var(--foreground)"
            }}
          >
            <span is-="spinner" variant-="dots" />
            <span>Thinking...</span>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      <div style={{ width: "100%", marginTop: "-0.5lh" }} is-="separator" />

      <div className="content">
        <div
          className="buttons"
          style={{ alignItems: "flex-start", width: "100%" }}
        >
          <label box-="round" shear-="top" style={{ flex: 1 }}>
            <div className="row">
              <span is-="badge" variant-="background0">
                Message
              </span>
            </div>
            <input
              placeholder="Ask about your memories…"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isLoading}
            />
          </label>
          <button
            box-="round"
            onClick={handleSend}
            disabled={isLoading}
            type="button"
          >
            {isLoading ? "Sending..." : "Send"}
          </button>
          <button onClick={onNewChat} disabled={isLoading} type="button">
            New chat
          </button>
        </div>
      </div>
    </>
  );
}
