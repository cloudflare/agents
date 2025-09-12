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
  const [authToken, setAuthToken] = useState("demo-token-123");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);

  // Cross-domain WebSocket connection with query parameter authentication
  const agent = useAgent({
    agent: "my-agent",
    host: "http://localhost:8787",
    query: {
      token: authToken, // Authentication token (demo-token-123)
      userId: "demo-user" // User identifier for server validation
    },
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
    onOpen: () => setIsConnected(true),
    onError: (error) => {
      console.error("WebSocket auth error:", error);
      setIsConnected(false);
    }
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
      // Cross-domain HTTP request with header-based authentication
      const response = await fetch(
        "http://localhost:8787/agents/my-agent/default",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${authToken}`, // Bearer token authentication
            "X-API-Key": "demo-api-key" // API key for additional validation
          }
        }
      );
      const data = await response.text();
      const newMessage: Message = {
        id: Math.random().toString(36).substring(7),
        text: `HTTP Response: ${data}`,
        timestamp: new Date(),
        type: "incoming"
      };
      setMessages((prev) => [...prev, newMessage]);
    } catch (error) {
      console.error("Error fetching from server:", error);
      const errorMessage: Message = {
        id: Math.random().toString(36).substring(7),
        text: `HTTP Error: ${error}`,
        timestamp: new Date(),
        type: "incoming"
      };
      setMessages((prev) => [...prev, errorMessage]);
    }
  };

  const updateAuthToken = () => {
    if (tokenInputRef.current?.value) {
      setAuthToken(tokenInputRef.current.value);
      // Note: Changing the token will require reconnecting the WebSocket
      window.location.reload();
    }
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="chat-container">
      <div className="auth-section">
        <h2>Cross-Domain Authentication Demo</h2>
        <div className="auth-controls">
          <input
            ref={tokenInputRef}
            type="text"
            placeholder="Enter auth token"
            defaultValue={authToken}
          />
          <button type="button" onClick={updateAuthToken}>
            Update Token
          </button>
        </div>
        <div className="status-indicator">
          <div className={`status-dot ${isConnected ? "connected" : ""}`} />
          {isConnected ? "Connected to server" : "Disconnected"}
        </div>
        <div className="auth-info">
          <p>
            <strong>🌐 Cross-Domain Setup:</strong>
          </p>
          <p>• Client: {window.location.origin} (this page)</p>
          <p>• Server: http://localhost:8787 (different port)</p>
          <p>
            <strong>🔗 WebSocket Auth:</strong> Query parameter (token=
            {authToken})
          </p>
          <p>
            <strong>📡 HTTP Auth:</strong> Bearer token + API key in headers
          </p>
          <p>
            <strong>🎯 Valid Token:</strong> "demo-token-123"
          </p>
          <p>
            <strong>🎯 Valid API Key:</strong> "demo-api-key"
          </p>
        </div>
      </div>

      <form className="message-form" onSubmit={handleSubmit}>
        <input
          type="text"
          ref={inputRef}
          className="message-input"
          placeholder="Type your message..."
          disabled={!isConnected}
        />
        <button type="submit" disabled={!isConnected}>
          Send WebSocket Message
        </button>
      </form>

      <button
        type="button"
        onClick={handleFetchRequest}
        className="http-button"
        disabled={!authToken}
      >
        Send Authenticated HTTP Request
      </button>

      <div className="messages-section">
        <h3>Messages</h3>
        <div className="messages">
          {messages.map((message) => (
            <div key={message.id} className={`message ${message.type}-message`}>
              <div>{message.text}</div>
              <div className="timestamp">{formatTime(message.timestamp)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="debug-section">
        <h4>Debug Information</h4>
        <div className="debug-info">
          <p>
            <strong>Agent:</strong> {agent.agent}
          </p>
          <p>
            <strong>Room:</strong> {agent.name}
          </p>
          <p>
            <strong>WebSocket Ready State:</strong> {agent.readyState}
          </p>
          <p>
            <strong>Auth Token:</strong> {authToken}
          </p>
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
