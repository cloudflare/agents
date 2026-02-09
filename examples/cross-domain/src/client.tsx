import { useAgent } from "agents/react";
import { useRef, useState, Suspense, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface Message {
  id: string;
  text: string;
  timestamp: Date;
  type: "incoming" | "outgoing";
}

// Mock authentication service
async function getAuthToken(): Promise<string> {
  // Simulate API call delay
  await new Promise((resolve) => setTimeout(resolve, 500));
  return "demo-token-123";
}

async function getCurrentUser(): Promise<{ id: string; name: string }> {
  // Simulate user data fetch
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { id: "demo-user", name: "Demo User" };
}

function AsyncAuthApp() {
  const [messages, setMessages] = useState<Message[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Async authentication query
  const asyncQuery = useCallback(async () => {
    console.log("🔐 Fetching authentication data...");
    const [token, user] = await Promise.all([getAuthToken(), getCurrentUser()]);

    console.log("✅ Auth data fetched:", { token, userId: user.id });
    return {
      token,
      userId: user.id,
      timestamp: Date.now().toString() // Convert to string for WebSocket compatibility
    };
  }, []);

  // Cross-domain WebSocket connection with async authentication using unified useAgent
  const agent = useAgent({
    agent: "my-agent",
    host: "http://localhost:8787",
    query: asyncQuery, // Async function - automatically detected and cached
    onMessage: (message: MessageEvent) => {
      const newMessage: Message = {
        id: Math.random().toString(36).substring(7),
        text: message.data as string,
        timestamp: new Date(),
        type: "incoming"
      };
      setMessages((prev) => [...prev, newMessage]);
    },
    onError: (error: Event) => {
      console.error("WebSocket error:", error);
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
      // Get fresh auth token for HTTP request
      const token = await getAuthToken();

      const response = await fetch(
        "http://localhost:8787/agents/my-agent/default",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-API-Key": "demo-api-key"
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

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="chat-container">
      <div className="auth-section">
        <h2>Cross-Domain Authentication Demo (Async)</h2>
        <div className="auth-info">
          <p>
            <strong>🚀 Async Authentication:</strong>
          </p>
          <p>• Token fetched dynamically from auth service</p>
          <p>• User data retrieved from API</p>
          <p>• WebSocket connection waits for auth completion</p>
          <p>• Uses React Suspense for loading states</p>
          <p>
            <strong>🌐 Cross-Domain Setup:</strong>
          </p>
          <p>• Client: {window.location.origin} (this page)</p>
          <p>• Server: http://localhost:8787 (different port)</p>
        </div>
      </div>

      <form className="message-form" onSubmit={handleSubmit}>
        <input
          type="text"
          ref={inputRef}
          className="message-input"
          placeholder="Type your message..."
        />
        <button type="submit">Send WebSocket Message</button>
      </form>

      <button
        type="button"
        onClick={handleFetchRequest}
        className="http-button"
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
        </div>
      </div>
    </div>
  );
}

function StaticAuthApp() {
  const [authToken, setAuthToken] = useState("demo-token-123");
  const [messages, setMessages] = useState<Message[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);

  // Cross-domain WebSocket connection with static query parameter authentication
  const agent = useAgent({
    agent: "my-agent",
    host: "http://localhost:8787",
    query: {
      token: authToken, // Authentication token (demo-token-123)
      userId: "demo-user" // User identifier for server validation
    },
    onMessage: (message) => {
      const newMessage: Message = {
        id: Math.random().toString(36).substring(7),
        text: message.data as string,
        timestamp: new Date(),
        type: "incoming"
      };
      setMessages((prev) => [...prev, newMessage]);
    },
    onError: (error) => {
      console.error("WebSocket auth error:", error);
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
    const newMessage: Message = {
      id: Math.random().toString(36).substring(7),
      text: "",
      timestamp: new Date(),
      type: "incoming"
    };
    try {
      // Cross-domain HTTP request with header-based authentication
      const response = await fetch(
        "http://localhost:8787/agents/my-agent/default",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${authToken}` // Bearer token authentication
          }
        }
      );
      const data = await response.text();
      newMessage.text = `HTTP Response: ${data}`;
    } catch (error) {
      console.error("Error fetching from server:", error);
      newMessage.text = `HTTP Error: ${error}`;
    } finally {
      setMessages((prev) => [...prev, newMessage]);
    }
  };

  const updateAuthToken = () => {
    if (tokenInputRef.current?.value) {
      setAuthToken(tokenInputRef.current.value);
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
        </div>
        <button type="button" onClick={updateAuthToken}>
          Update Token
        </button>
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
        />
        <button type="submit">Send WebSocket Message</button>
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
            <strong>Auth Token:</strong> {authToken}
          </p>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [useAsync, setUseAsync] = useState(false);

  return (
    <div>
      <div
        style={{
          padding: "20px",
          borderBottom: "2px solid #ddd",
          backgroundColor: "#f5f5f5"
        }}
      >
        <h1>Cross-Domain Authentication Examples</h1>
        <div style={{ marginBottom: "10px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <input
              type="checkbox"
              checked={useAsync}
              onChange={(e) => setUseAsync(e.target.checked)}
            />
            Use Async Authentication (useAgent with async query)
          </label>
        </div>
        <p style={{ margin: 0, fontSize: "14px", color: "#666" }}>
          Toggle between static authentication (useAgent) and async
          authentication (useAgent with async query)
        </p>
      </div>

      <Suspense
        fallback={
          <div style={{ padding: "20px", textAlign: "center" }}>
            <div>🔐 Loading authentication...</div>
            <div style={{ fontSize: "14px", color: "#666", marginTop: "8px" }}>
              Fetching auth token and user data...
            </div>
          </div>
        }
      >
        {useAsync ? <AsyncAuthApp /> : <StaticAuthApp />}
      </Suspense>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
