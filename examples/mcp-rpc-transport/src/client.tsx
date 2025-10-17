import "./styles.css";
import { useAgent } from "agents/react";
import { useAgentChat } from "agents/ai-react";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MCPServersState } from "agents";

function App() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const savedTheme = localStorage.getItem("theme");
    return (savedTheme as "dark" | "light") || "dark";
  });

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [mcpState, setMcpState] = useState<MCPServersState>({
    prompts: [],
    resources: [],
    servers: {},
    tools: []
  });
  const [showMcpServers, setShowMcpServers] = useState(false);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
      document.documentElement.classList.remove("light");
    } else {
      document.documentElement.classList.remove("dark");
      document.documentElement.classList.add("light");
    }
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  const openPopup = (authUrl: string) => {
    window.open(
      authUrl,
      "popupWindow",
      "width=600,height=800,resizable=yes,scrollbars=yes,toolbar=yes,menubar=no,location=no,directories=no,status=yes"
    );
  };

  const agent = useAgent({
    agent: "chat",
    onMcpUpdate: (mcpServers: MCPServersState) => {
      setMcpState(mcpServers);
    }
  });

  const { messages, sendMessage, clearHistory } = useAgentChat({
    agent
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const message = input;
    setInput("");

    await sendMessage({
      role: "user",
      parts: [{ type: "text", text: message }]
    });
  };

  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  return (
    <div
      className={`h-screen flex flex-col ${theme === "dark" ? "dark bg-gray-900 text-white" : "bg-white text-black"}`}
    >
      {/* Header */}
      <div
        className={`border-b p-4 flex items-center justify-between ${theme === "dark" ? "border-gray-700 bg-gray-800" : "border-gray-200 bg-gray-50"}`}
      >
        <h1 className="text-xl font-semibold">Chat Agent</h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowMcpServers(!showMcpServers)}
            className={`p-2 rounded-lg ${theme === "dark" ? "bg-gray-700 hover:bg-gray-600" : "bg-gray-200 hover:bg-gray-300"}`}
          >
            🔌 {Object.keys(mcpState.servers).length}
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            className={`p-2 rounded-lg ${theme === "dark" ? "bg-gray-700 hover:bg-gray-600" : "bg-gray-200 hover:bg-gray-300"}`}
          >
            {theme === "dark" ? "🌙" : "☀️"}
          </button>
          <button
            type="button"
            onClick={clearHistory}
            className={`p-2 rounded-lg ${theme === "dark" ? "bg-gray-700 hover:bg-gray-600" : "bg-gray-200 hover:bg-gray-300"}`}
          >
            🗑️
          </button>
        </div>
      </div>

      {/* MCP Servers Panel */}
      {showMcpServers && (
        <div
          className={`border-b p-4 ${theme === "dark" ? "border-gray-700 bg-gray-800" : "border-gray-200 bg-gray-50"}`}
        >
          <h2 className="text-lg font-semibold mb-3">MCP Servers</h2>
          <div className="space-y-2">
            {Object.entries(mcpState.servers).map(([id, server]) => (
              <div
                key={id}
                className={`p-3 rounded-lg flex items-center justify-between ${theme === "dark" ? "bg-gray-700" : "bg-gray-100"}`}
              >
                <div className="flex-1">
                  <div className="font-semibold">{server.name}</div>
                  <div
                    className={`text-sm ${theme === "dark" ? "text-gray-400" : "text-gray-600"}`}
                  >
                    {server.server_url}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <div
                      className={`w-2 h-2 rounded-full ${
                        server.state === "ready"
                          ? "bg-green-500"
                          : server.state === "authenticating"
                            ? "bg-yellow-500"
                            : "bg-gray-500"
                      }`}
                    />
                    <span className="text-sm">{server.state}</span>
                  </div>
                </div>
                {server.state === "authenticating" && server.auth_url && (
                  <button
                    type="button"
                    onClick={() => openPopup(server.auth_url as string)}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    Authorize
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div
              className={`text-center p-8 rounded-lg ${theme === "dark" ? "bg-gray-800" : "bg-gray-100"}`}
            >
              <div className="text-4xl mb-4">💬</div>
              <h2 className="text-xl font-semibold mb-2">Welcome to Chat</h2>
              <p
                className={theme === "dark" ? "text-gray-400" : "text-gray-600"}
              >
                Start a conversation with your AI assistant
              </p>
            </div>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
                message.role === "user"
                  ? theme === "dark"
                    ? "bg-blue-600 text-white"
                    : "bg-blue-500 text-white"
                  : theme === "dark"
                    ? "bg-gray-700 text-white"
                    : "bg-gray-200 text-black"
              }`}
            >
              {message.parts
                ?.filter((part) => part.type === "text")
                .map((part, i) => (
                  <div
                    key={`${part.type}-${part.text}-${i}`}
                    className="whitespace-pre-wrap"
                  >
                    {part.text}
                  </div>
                ))}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        className={`border-t p-4 ${theme === "dark" ? "border-gray-700 bg-gray-800" : "border-gray-200 bg-gray-50"}`}
      >
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message..."
            className={`flex-1 p-3 rounded-lg border ${
              theme === "dark"
                ? "bg-gray-700 border-gray-600 text-white placeholder-gray-400"
                : "bg-white border-gray-300 text-black placeholder-gray-500"
            } focus:outline-none focus:ring-2 focus:ring-blue-500`}
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
