import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import "./styles.css";
import { generateId, type UIMessage } from "ai";
import { useState } from "react";
import type { Codemode } from "./server";
import type { MCPServersState } from "agents";

function App() {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [inputMessage, setInputMessage] = useState("");
  const [mcpServers, setMcpServers] = useState<MCPServersState>();
  const [newServerName, setNewServerName] = useState("");
  const [newServerUrl, setNewServerUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const agent = useAgent<Codemode, { messages: UIMessage[]; loading: boolean }>(
    {
      agent: "codemode",
      onStateUpdate: (state) => {
        setMessages(state.messages);
        setLoading(state.loading);
      },
      onMcpUpdate: (mcpServers) => {
        setMcpServers(mcpServers);
      }
    }
  );

  const addMCPServer = () => {
    if (!newServerName.trim() || !newServerUrl.trim()) return;

    agent.call("addMcp", [
      { name: newServerName.trim(), url: newServerUrl.trim() }
    ]);
    setNewServerName("");
    setNewServerUrl("");
  };

  const removeMCPServer = (id: string) => {
    agent.call("removeMcp", [id]);
  };

  const sendMessage = async () => {
    if (!inputMessage.trim()) return;

    const userMessage: UIMessage = {
      id: generateId(),
      role: "user",
      parts: [
        {
          type: "text",
          text: inputMessage
        }
      ]
    };

    agent.setState({ messages: [...messages, userMessage], loading }); // setMessages((prev) => [...prev, userMessage]);
    setInputMessage("");

    // Simulate AI response
    // setTimeout(() => {
    //   const aiMessage: UIMessage = {
    //     id: (Date.now() + 1).toString(),
    //     role: "assistant",
    //     parts: [
    //       {
    //         type: "text",
    //         text: `I received your message: "${inputMessage}". This is a simulated response.`
    //       }
    //     ]
    //   };
    //   setMessages((prev) => [...prev, aiMessage]);
    // }, 1000);
  };

  const resetMessages = () => {
    agent.setState({ messages: [], loading: false });
  };

  // const getStatusColor = (status: MCPServer["status"]) => {
  //   switch (status) {
  //     case "connected":
  //       return "#4ade80";
  //     case "connecting":
  //       return "#fbbf24";
  //     case "disconnected":
  //       return "#6b7280";
  //     case "error":
  //       return "#ef4444";
  //     default:
  //       return "#6b7280";
  //   }
  // };

  return (
    <div className="app">
      <header className="header">
        <h1>CodeMode Testing App</h1>
        <p>Test MCP servers and chat with LLM</p>
      </header>

      <div className="main-content">
        {/* MCP Servers Section */}
        <section className="mcp-section">
          <h2>MCP Servers</h2>

          {/* Add Server Form */}
          <div className="add-server-form">
            <div className="form-group">
              <input
                type="text"
                placeholder="Server Name"
                value={newServerName}
                onChange={(e) => setNewServerName(e.target.value)}
              />
              <input
                type="url"
                placeholder="Server URL"
                value={newServerUrl}
                onChange={(e) => setNewServerUrl(e.target.value)}
              />
              <button
                type="button"
                onClick={addMCPServer}
                disabled={!newServerName.trim() || !newServerUrl.trim()}
              >
                Add Server
              </button>
            </div>
          </div>

          {/* Server List */}
          <div className="server-list">
            {Object.entries(mcpServers?.servers ?? {}).map(([id, server]) => (
              <div key={id} className="server-card">
                <div className="server-header">
                  <div className="server-info">
                    <h3>{server.name}</h3>
                    <p className="server-url">{server.server_url}</p>
                  </div>
                  <div className="server-actions">
                    {/* <div
                      className="status-indicator"
                      style={{ backgroundColor: getStatusColor(server.state) }}
                      title={server.status}
                    /> */}
                    <button
                      type="button"
                      onClick={() => removeMCPServer(id)}
                      className="remove-btn"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {
                  // server.status === "connected" && server.tools.length > 0 && (
                  <div className="server-tools">
                    <h4>Available Tools:</h4>
                    <div className="tools-list">
                      {mcpServers?.tools
                        .filter((tool) => tool.serverId === id)
                        .map((tool) => (
                          <span key={tool.name} className="tool-tag">
                            {tool.name}
                          </span>
                        ))}
                    </div>
                  </div>
                  //)
                }
              </div>
            ))}
          </div>
        </section>

        {/* Chat Section */}
        <section className="chat-section">
          <div className="chat-header">
            <h2>Chat with LLM</h2>
            <button
              type="button"
              onClick={resetMessages}
              className="reset-btn"
              disabled={messages.length === 0}
            >
              Reset Chat
            </button>
          </div>

          <div className="chat-container">
            <div className="messages">
              {messages.map((message) => (
                <div key={message.id} className={`message ${message.role}`}>
                  <div className="message-content">
                    {message.parts.map((part, index) => (
                      <div key={`${message.id}-part-${index}`}>
                        {part.type === "text"
                          ? part.text
                          : JSON.stringify(part)}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="message assistant">
                  <div className="message-content">
                    <div className="loading-indicator">...</div>
                  </div>
                </div>
              )}
            </div>

            <div className="chat-input">
              <input
                type="text"
                placeholder="Type your message..."
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyPress={(e) => e.key === "Enter" && sendMessage()}
              />
              <button
                type="button"
                onClick={sendMessage}
                disabled={!inputMessage.trim()}
              >
                Send
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
