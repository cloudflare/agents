import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import "./styles.css";
import { generateId, type UIMessage } from "ai";
import { useState, useEffect, useRef } from "react";
import type { Codemode } from "./server";
import type { MCPServersState } from "agents";

/**
 * The AI SDK exports ToolUIPart, but it's generic over tool definitions.
 * Since this component accesses codemode-specific fields (functionDescription,
 * code) that aren't on the generic type, we define a local interface instead.
 * Fields mirror UIToolInvocation from the AI SDK (toolCallId, state, input,
 * output, errorText) with codemode-specific input/output shapes.
 */
interface ToolPart {
  type: string;
  toolCallId?: string;
  state?: string;
  errorText?: string;
  input?: { functionDescription?: string; [key: string]: unknown };
  output?: { code?: string; result?: string; [key: string]: unknown };
}

/** Runtime check: returns the part as a ToolPart if it's a tool-* type, or null. */
function asToolPart(part: UIMessage["parts"][0]): ToolPart | null {
  if (!part.type.startsWith("tool-")) return null;
  // The AI SDK's ToolUIPart has the same fields (toolCallId, state, input,
  // output, errorText) but its generic type is incompatible with our local
  // ToolPart. A runtime coercion is safe here because we only read known fields.
  return part as unknown as ToolPart;
}

// Component to render different types of message parts
function MessagePart({ part }: { part: UIMessage["parts"][0] }) {
  if (part.type === "text") {
    return <span>{part.text}</span>;
  }

  // Don't show step-start blocks
  if (part.type === "step-start") {
    return null;
  }

  if (part.type === "reasoning") {
    // Only show reasoning blocks if they have content
    if (!part.text || part.text.trim() === "") {
      return null;
    }

    return (
      <div className="part-block reasoning-block">
        <div className="part-header">
          <span className="part-icon">🧠</span>
          <span className="part-title">Reasoning</span>
        </div>
        <div className="part-content">{part.text}</div>
      </div>
    );
  }

  if (part.type === "file") {
    return (
      <div className="part-block file-block">
        <div className="part-header">
          <span className="part-icon">📄</span>
          <span className="part-title">
            File: {part.filename || "Untitled"}
          </span>
        </div>
        <div className="part-content">
          <div className="file-info">
            <span className="file-type">{part.mediaType}</span>
            {part.url && (
              <a
                href={part.url}
                target="_blank"
                rel="noopener noreferrer"
                className="file-link"
              >
                View File
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  const toolPart = asToolPart(part);
  if (toolPart) {
    const toolName = toolPart.type.replace("tool-", "");
    return (
      <div className="part-block tool-block">
        <div className="part-header">
          <span className="part-icon">🔧</span>
          <span className="part-title">Tool: {toolName}</span>
          {toolPart.state && (
            <span className={`tool-state ${toolPart.state}`}>
              {toolPart.state}
            </span>
          )}
        </div>
        <div className="part-content">
          {toolPart.input && (
            <div className="tool-section">
              <div className="tool-section-title">Input:</div>
              <div className="tool-data-container">
                {toolPart.input.functionDescription ? (
                  <div className="input-description">
                    <div className="input-header">
                      <span className="input-icon">📝</span>
                      <span className="input-title">Function Description</span>
                    </div>
                    <div className="input-content">
                      {toolPart.input.functionDescription}
                    </div>
                  </div>
                ) : null}
                {Object.keys(toolPart.input).length > 1 ||
                !toolPart.input.functionDescription ? (
                  <div className="input-raw">
                    <div className="input-raw-header">Raw Input:</div>
                    <pre className="tool-data">
                      {JSON.stringify(toolPart.input, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </div>
            </div>
          )}
          {toolPart.output && (
            <div className="tool-section">
              <div className="tool-section-title">Output:</div>
              <div className="tool-data-container">
                {toolPart.output.code ? (
                  <div className="code-output">
                    <div className="code-header">
                      <span className="code-language">JavaScript</span>
                      <button
                        type="button"
                        className="copy-button"
                        onClick={() =>
                          toolPart.output?.code &&
                          navigator.clipboard.writeText(toolPart.output.code)
                        }
                        title="Copy code"
                      >
                        📋
                      </button>
                    </div>
                    <pre className="code-content">
                      <code>{toolPart.output.code}</code>
                    </pre>
                  </div>
                ) : null}
                {toolPart.output.result && (
                  <div className="result-output">
                    <div className="result-header">Result:</div>
                    <pre className="result-data">
                      {JSON.stringify(toolPart.output.result, null, 2)}
                    </pre>
                  </div>
                )}
                {!toolPart.output.code && !toolPart.output.result && (
                  <pre className="tool-data">
                    {JSON.stringify(toolPart.output, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          )}
          {toolPart.errorText && (
            <div className="tool-section error">
              <div className="tool-section-title">Error:</div>
              <div className="tool-data-container">
                <pre className="tool-data error-data">{toolPart.errorText}</pre>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Fallback for unknown part types
  return (
    <div className="part-block unknown-block">
      <div className="part-header">
        <span className="part-icon">❓</span>
        <span className="part-title">{part.type}</span>
      </div>
      <div className="part-content">
        <pre className="part-data">{JSON.stringify(part, null, 2)}</pre>
      </div>
    </div>
  );
}

function App() {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [inputMessage, setInputMessage] = useState("");
  const [mcpServers, setMcpServers] = useState<MCPServersState>();
  const [newServerName, setNewServerName] = useState("");
  const [newServerUrl, setNewServerUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
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

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

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
                Add
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
                        <MessagePart part={part} />
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
              <div ref={messagesEndRef} />
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
