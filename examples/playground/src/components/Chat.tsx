import "./Chat.css";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";

const ROOMS = [
  { id: "1", label: "Room 1" },
  { id: "2", label: "Room 2" },
  { id: "3", label: "Room 3" }
];

interface ChatProps {
  roomId: string;
}

function ChatRoom({ roomId }: ChatProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Scroll to bottom on mount
  useEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  const agent = useAgent({
    agent: "chat",
    name: `chat-${roomId}`
  });

  const { messages, clearHistory, sendMessage } = useAgentChat({
    agent
  });

  const [input, setInput] = useState("");

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const message = input;
    setInput("");

    // Send message to agent
    await sendMessage({
      role: "user",
      parts: [{ type: "text", text: message }]
    });
  };

  // Scroll to bottom when messages change
  useEffect(() => {
    messages.length > 0 && scrollToBottom();
  }, [messages, scrollToBottom]);

  return (
    <>
      <div className="controls-container">
        <button type="button" onClick={clearHistory} className="clear-history">
          🗑️ Clear History
        </button>
      </div>

      <div className="chat-container">
        <div className="messages-wrapper">
          {messages?.map((m) => (
            <div key={m.id} className="message">
              <strong>{`${m.role}: `}</strong>
              {m.parts
                ?.filter((part) => part.type === "text")
                .map((part, i) => (
                  <div key={i} className="message-content">
                    {part.text}
                  </div>
                ))}
              <br />
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <form onSubmit={handleSubmit}>
          <input
            className="chat-input"
            value={input}
            placeholder={`Say something in Room ${roomId}...`}
            onChange={handleInputChange}
          />
        </form>
      </div>
    </>
  );
}

export default function Chat() {
  const [activeRoom, setActiveRoom] = useState(ROOMS[0].id);

  return (
    <div className="chat-wrapper">
      <div className="tab-bar">
        {ROOMS.map((room) => (
          <button
            key={room.id}
            type="button"
            className={`tab ${activeRoom === room.id ? "active" : ""}`}
            onClick={() => setActiveRoom(room.id)}
          >
            {room.label}
          </button>
        ))}
      </div>
      <ChatRoom roomId={activeRoom} key={activeRoom} />
    </div>
  );
}
