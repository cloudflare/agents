import { agentFetch } from "agents/client";
import { useAgent } from "agents/react";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface Message {
  id: string;
  text: string;
  timestamp: Date;
  type: "incoming" | "outgoing";
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const agent = useAgent({
    agent: "my-agent",
    host: "http://localhost:8787",
    onClose: () => setIsConnected(false),
    onMessage: (message) => {
      const newMessage: Message = {
        id: Math.random().toString(36).substring(7),
        text: message.data as string,
        timestamp: new Date(),
        type: "incoming"
      };
      setMessages((prev) => [...prev, newMessage]);
    },
    onOpen: () => setIsConnected(true)
  });

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!inputRef.current || !inputRef.current.value.trim()) return;

    const text = inputRef.current.value;
    const newMessage: Message = {
      id: Math.random().toString(36).substring(7),
      text,
      timestamp: new Date(),
      type: "outgoing"
    };

    agent.send(text);
    setMessages((prev) => [...prev, newMessage]);
    inputRef.current.value = "";
  };

  const handleFetchRequest = async () => {
    try {
      const response = await agentFetch({
        agent: "my-agent",
        host: "http://localhost:8787"
      });
      const data = await response.text.text();
      const newMessage: Message = {
        id: Math.random().toString(36).substring(7),
        text: `Server Response: ${data}`,
        timestamp: new Date(),
        type: "incoming"
      };
      setMessages((prev) => [...prev, newMessage]);
    } catch (error) {
      console.error("Error fetching from server:", error);
    }
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="chat-container">
      <div className="status-indicator">
        <div className={`status-dot ${isConnected ? "connected" : ""}`} />
        {isConnected ? "Connected to server" : "Disconnected"}
      </div>

      <form className="message-form" onSubmit={handleSubmit}>
        <input
          type="text"
          ref={inputRef}
          className="message-input"
          placeholder="Type your message..."
        />
        <button type="submit">Send</button>
      </form>

      <div className="messages-section">
        <h2>Messages</h2>
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.type}-message`}>
            <div>{message.text}</div>
            <div className="timestamp">{formatTime(message.timestamp)}</div>
          </div>
        ))}
      </div>

      <button type="button" onClick={handleFetchRequest}>
        Send HTTP Request
      </button>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
