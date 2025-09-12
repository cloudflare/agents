import "./styles.css";
import { createRoot } from "react-dom/client";
import { useState, useEffect, useRef } from "react";

interface WalletStatus {
  balance: { currency: string; amount: number };
  totalSpent: number;
  network: string;
}

interface SpendingHistory {
  history: Array<{
    toolName: string;
    cost: number;
    timestamp: number;
    success: boolean;
  }>;
  totalSpent: number;
  conversationCount: number;
}

function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [walletStatus, setWalletStatus] = useState<WalletStatus | null>(null);
  const [spendingHistory, setSpendingHistory] =
    useState<SpendingHistory | null>(null);
  const [showPremiumDemo, setShowPremiumDemo] = useState(false);
  const [premiumResponse, setPremiumResponse] = useState<string>("");
  const [messages, setMessages] = useState<
    Array<{ id: string; role: string; content: string }>
  >([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage = {
      id: Date.now().toString(),
      role: "user",
      content: input
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMessage]
        })
      });

      if (response.ok) {
        const text = await response.text();
        setMessages((prev) => [
          ...prev,
          { id: Date.now().toString(), role: "assistant", content: text }
        ]);
      }
    } catch (error) {
      console.error("Chat error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const toggleTheme = () => {
    const newTheme = theme === "dark" ? "light" : "dark";
    setTheme(newTheme);
  };

  const clearHistory = () => {
    setMessages([]);
  };

  useEffect(() => {
    fetchWalletStatus();
    fetchSpendingHistory();
  }, []);

  const fetchWalletStatus = async () => {
    try {
      const response = await fetch("/api/wallet/status");
      if (response.ok) {
        const data = (await response.json()) as WalletStatus;
        setWalletStatus(data);
      }
    } catch (error) {
      console.error("Failed to fetch wallet status:", error);
    }
  };

  const fetchSpendingHistory = async () => {
    try {
      const response = await fetch("/api/spending/history");
      if (response.ok) {
        const data = (await response.json()) as SpendingHistory;
        setSpendingHistory(data);
      }
    } catch (error) {
      console.error("Failed to fetch spending history:", error);
    }
  };

  const handlePremiumChat = async () => {
    const message =
      "Explain the benefits of blockchain technology for small businesses";

    try {
      const response = await fetch("/api/premium-chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment-Authorization": JSON.stringify({
            paymentId: `demo_${Date.now()}`,
            amount: 0.001,
            currency: "USDC",
            recipient: "demo-wallet-address",
            timestamp: Date.now(),
            signature: "demo_signature"
          })
        },
        body: JSON.stringify({ message })
      });

      if (response.ok) {
        const data = (await response.json()) as { response: string };
        setPremiumResponse(data.response);
        setShowPremiumDemo(true);
        fetchSpendingHistory();
      } else if (response.status === 402) {
        const paymentRequired = response.headers.get("X-Payment-Required");
        alert(`Payment required: ${paymentRequired}`);
      }
    } catch (error) {
      console.error("Premium chat error:", error);
    }
  };

  return (
    <>
      <div className="controls-container">
        <button
          type="button"
          onClick={toggleTheme}
          className="theme-switch"
          data-theme={theme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          <div className="theme-switch-handle" />
        </button>
      </div>

      <div className="app-container">
        <header className="app-header">
          <h1 className="app-title">🚀 X402 AI Starter</h1>
          <p className="app-subtitle">
            AI Chat with Paid Tools using X402 Protocol & Cloudflare Agents
          </p>
        </header>

        <div className="dashboard-grid">
          <div className="card">
            <div className="card-header">
              <span className="card-icon">💰</span>
              <h3 className="card-title">Wallet Status</h3>
            </div>
            <div className="card-content">
              {walletStatus ? (
                <div className="status-grid">
                  <div className="status-item">
                    <span className="status-label">Balance</span>
                    <span className="status-value currency">
                      {walletStatus.balance.amount.toFixed(3)}{" "}
                      {walletStatus.balance.currency}
                    </span>
                  </div>
                  <div className="status-item">
                    <span className="status-label">Total Spent</span>
                    <span className="status-value">
                      ${walletStatus.totalSpent.toFixed(3)}
                    </span>
                  </div>
                  <div className="status-item">
                    <span className="status-label">Network</span>
                    <span className="status-value network">
                      {walletStatus.network}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="empty-state">
                  <div className="loading-spinner"></div>
                  <p className="empty-state-text">Loading wallet status...</p>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-icon">📊</span>
              <h3 className="card-title">Usage Stats</h3>
            </div>
            <div className="card-content">
              {spendingHistory ? (
                <div className="status-grid">
                  <div className="status-item">
                    <span className="status-label">Total Spent</span>
                    <span className="status-value">
                      ${spendingHistory.totalSpent.toFixed(3)}
                    </span>
                  </div>
                  <div className="status-item">
                    <span className="status-label">Conversations</span>
                    <span className="status-value">
                      {spendingHistory.conversationCount}
                    </span>
                  </div>
                  <div className="status-item">
                    <span className="status-label">Tools Used</span>
                    <span className="status-value">
                      {spendingHistory.history.length}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="empty-state">
                  <div className="loading-spinner"></div>
                  <p className="empty-state-text">Loading usage stats...</p>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="chat-section">
          <div className="chat-header">
            <h2 className="chat-title">
              <span>💬</span> AI Chat
            </h2>
            <button onClick={clearHistory} className="clear-chat">
              🗑️ Clear
            </button>
          </div>

          <div className="messages-container">
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">💭</div>
                <p className="empty-state-text">Start a conversation...</p>
              </div>
            ) : (
              messages.map((msg) => (
                <div key={msg.id} className={`message ${msg.role}`}>
                  <div className="message-role">
                    {msg.role === "user" ? "You" : "Assistant"}
                  </div>
                  <div className="message-content">{msg.content}</div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          <form onSubmit={handleSubmit} className="chat-form">
            <input
              type="text"
              value={input}
              onChange={handleInputChange}
              placeholder="Type your message..."
              disabled={isLoading}
              className="chat-input"
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="button button-primary"
            >
              {isLoading ? (
                <>
                  <span className="loading-spinner"></span>
                  Sending...
                </>
              ) : (
                "Send"
              )}
            </button>
          </form>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-icon">⭐</span>
            <h2 className="card-title">Premium Features</h2>
          </div>
          <div className="card-content">
            <p style={{ marginBottom: "1rem", color: "var(--secondary-text)" }}>
              Test X402 protocol with paid AI tools. Click below to try a
              premium chat feature.
            </p>
            <button
              onClick={handlePremiumChat}
              className="button button-success"
              style={{ width: "100%" }}
            >
              Try Premium Chat ($0.001 USDC)
            </button>
            {showPremiumDemo && (
              <div className="premium-content" style={{ marginTop: "1rem" }}>
                <h4 style={{ marginBottom: "0.5rem" }}>Premium Response:</h4>
                <p>{premiumResponse}</p>
              </div>
            )}
          </div>
        </div>

        {spendingHistory && spendingHistory.history.length > 0 && (
          <div className="card">
            <div className="card-header">
              <span className="card-icon">🛠️</span>
              <h2 className="card-title">Tool Usage History</h2>
            </div>
            <div className="card-content">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Cost</th>
                    <th>Time</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {spendingHistory.history.map((item, idx) => (
                    <tr key={idx}>
                      <td>{item.toolName}</td>
                      <td>${item.cost.toFixed(3)}</td>
                      <td>{new Date(item.timestamp).toLocaleTimeString()}</td>
                      <td>
                        <span
                          className={
                            item.success
                              ? "badge badge-success"
                              : "badge badge-error"
                          }
                        >
                          {item.success ? "Success" : "Failed"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
