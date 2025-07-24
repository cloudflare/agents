import { useAgent } from "agents/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { MCPServersState } from "agents";
import { agentFetch } from "agents/client";
import { nanoid } from "nanoid";
import "./styles.css";

// Force new session for this demo
const sessionId = `demo-${nanoid(8)}`;

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [mcpState, setMcpState] = useState<MCPServersState>({
    prompts: [],
    resources: [],
    servers: {},
    tools: []
  });
  const [elicitationRequest, setElicitationRequest] = useState<{
    id: string;
    message: string;
    schema: {
      type: string;
      properties?: Record<
        string,
        {
          type: string;
          title?: string;
          description?: string;
          format?: string;
          enum?: string[];
          enumNames?: string[];
        }
      >;
      required?: string[];
    };
    resolve: (formData: Record<string, unknown>) => void;
    reject: () => void;
    cancel: () => void;
  } | null>(null);
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [toolResults, setToolResults] = useState<
    Array<{ tool: string; result: string; timestamp: number }>
  >([]);

  const agent = useAgent({
    agent: "MyAgent",
    name: sessionId,
    onClose: () => setIsConnected(false),
    onOpen: () => {
      setIsConnected(true);
      // Auto-connect local server on startup
      setTimeout(() => {
        addLocalServer();
      }, 1000);
    },
    onMcpUpdate: (mcpServers: MCPServersState) => {
      setMcpState(mcpServers);
    },
    onMessage: (message: { data: string }) => {
      // Handle elicitation requests from MCP server following MCP specification
      try {
        const parsed = JSON.parse(message.data);
        if (parsed.method === "elicitation/create") {
          setElicitationRequest({
            id: parsed.id,
            message: parsed.params.message,
            schema: parsed.params.requestedSchema,
            resolve: (formData: Record<string, unknown>) => {
              // Send elicitation response back to server following MCP spec
              const response = {
                jsonrpc: "2.0",
                id: parsed.id,
                result: {
                  action: "accept",
                  content: formData
                }
              };
              console.log("Sending elicitation response:", response);
              agent.send(JSON.stringify(response));
              setElicitationRequest(null);
              setFormData({});
            },
            reject: () => {
              // Send decline back to server following MCP spec
              agent.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: {
                    action: "decline"
                  }
                })
              );
              setElicitationRequest(null);
              setFormData({});
            },
            cancel: () => {
              // Send cancel back to server following MCP spec
              agent.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: {
                    action: "cancel"
                  }
                })
              );
              setElicitationRequest(null);
              setFormData({});
            }
          });
        }
      } catch {
        // If parsing fails, let the default handler deal with it
        console.log("Non-elicitation message:", message.data);
      }
    }
  });

  const addLocalServer = () => {
    const serverUrl = `${window.location.origin}/mcp-server`;
    const serverName = "Local Demo Server";

    agentFetch(
      {
        agent: "MyAgent",
        host: agent.host,
        name: sessionId,
        path: "add-mcp"
      },
      {
        body: JSON.stringify({ name: serverName, url: serverUrl }),
        method: "POST"
      }
    );
  };

  const callTool = async (toolName: string, serverId: string) => {
    try {
      let args: Record<string, unknown> = {};

      // Set default arguments for tools
      if (toolName === "increment-counter") {
        args = { amount: 1 };
      } else if (toolName === "create-user") {
        const username = prompt("Enter username:") || "testuser";
        args = { username };
      }

      console.log(
        `Calling tool ${toolName} on server ${serverId} with args:`,
        args
      );

      // Call the real MCP tool through the agent
      const result = await agent.call("callMcpTool", [
        serverId,
        toolName,
        args
      ]);
      console.log("Tool result:", result);

      // Add result to display
      setToolResults((prev) => [
        {
          tool: toolName,
          result: JSON.stringify(result, null, 2),
          timestamp: Date.now()
        },
        ...prev.slice(0, 4)
      ]);
    } catch (error) {
      console.error("Error calling tool:", error);

      // Show error in results
      setToolResults((prev) => [
        {
          tool: toolName,
          result: JSON.stringify(
            { error: error instanceof Error ? error.message : String(error) },
            null,
            2
          ),
          timestamp: Date.now()
        },
        ...prev.slice(0, 4)
      ]);
    }
  };

  return (
    <div className="container">
      <div className="header">
        <h1>MCP Elicitation Demo</h1>
        <div className="status-indicator">
          <div className={`status-dot ${isConnected ? "connected" : ""}`} />
          {isConnected ? "Connected" : "Disconnected"}
        </div>
      </div>

      <div className="section">
        <h2>Connected Servers ({Object.keys(mcpState.servers).length})</h2>
        {Object.entries(mcpState.servers).map(([id, server]) => (
          <div key={id} className="server-item">
            <div className="server-info">
              <strong>{server.name}</strong>
              <span className="server-url">{server.server_url}</span>
            </div>
            <div className="status-indicator">
              <div
                className={`status-dot ${server.state === "ready" ? "connected" : ""}`}
              />
              {server.state}
            </div>
            {server.state === "authenticating" && server.auth_url && (
              <button
                type="button"
                onClick={() => window.open(server.auth_url as string, "_blank")}
                className="auth-btn"
              >
                Authorize
              </button>
            )}
          </div>
        ))}
      </div>

      {mcpState.tools.length > 0 && (
        <div className="section">
          <h2>Available Tools ({mcpState.tools.length})</h2>
          {mcpState.tools.map((tool) => (
            <div key={`${tool.name}-${tool.serverId}`} className="tool-item">
              <div className="tool-header">
                <strong>{tool.name}</strong>
                <button
                  type="button"
                  onClick={() => callTool(tool.name, tool.serverId as string)}
                  className="call-tool-btn"
                >
                  Call Tool
                </button>
              </div>
              <p>{tool.description}</p>
            </div>
          ))}
        </div>
      )}

      {mcpState.resources.length > 0 && (
        <div className="section">
          <h2>Resources ({mcpState.resources.length})</h2>
          {mcpState.resources.map((resource) => (
            <div
              key={`${resource.name}-${resource.serverId}`}
              className="resource-item"
            >
              <strong>{resource.name}</strong>
              <span className="resource-uri">{resource.uri}</span>
            </div>
          ))}
        </div>
      )}

      {toolResults.length > 0 && (
        <div className="section">
          <h2>Tool Results</h2>
          {toolResults.map((result) => (
            <div key={result.timestamp} className="result-item">
              <div className="result-header">
                <strong>{result.tool}</strong>
                <span className="result-time">
                  {new Date(result.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <pre className="result-content">{result.result}</pre>
            </div>
          ))}
        </div>
      )}

      {/* Elicitation Modal */}
      {elicitationRequest && (
        <div className="elicitation-overlay">
          <div className="elicitation-modal">
            <div className="elicitation-header">
              <h3>{elicitationRequest.message}</h3>
              <p className="elicitation-source">
                Requested by: MCP Demo Server
              </p>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                elicitationRequest.resolve(formData);
                setElicitationRequest(null);
                setFormData({});
              }}
            >
              {Object.entries(elicitationRequest.schema.properties || {}).map(
                ([key, prop]: [
                  string,
                  {
                    type: string;
                    title?: string;
                    description?: string;
                    format?: string;
                    enum?: string[];
                    enumNames?: string[];
                  }
                ]) => (
                  <div key={key} className="form-field">
                    <label htmlFor={key}>{prop.title || key}</label>
                    {prop.description && (
                      <p className="field-description">{prop.description}</p>
                    )}

                    {prop.type === "boolean" ? (
                      <input
                        type="checkbox"
                        id={key}
                        checked={Boolean(formData[key])}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            [key]: e.target.checked
                          }))
                        }
                      />
                    ) : prop.enum ? (
                      <select
                        id={key}
                        value={String(formData[key] || "")}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            [key]: e.target.value
                          }))
                        }
                        required={elicitationRequest.schema.required?.includes(
                          key
                        )}
                      >
                        <option value="">Select...</option>
                        {prop.enum!.map((option: string, idx: number) => (
                          <option key={option} value={option}>
                            {prop.enumNames?.[idx] || option}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={prop.format === "email" ? "email" : "text"}
                        id={key}
                        value={String(formData[key] || "")}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            [key]: e.target.value
                          }))
                        }
                        required={elicitationRequest.schema.required?.includes(
                          key
                        )}
                      />
                    )}
                  </div>
                )
              )}

              <div className="form-actions">
                <button
                  type="button"
                  onClick={() => {
                    elicitationRequest.cancel();
                    setElicitationRequest(null);
                    setFormData({});
                  }}
                  className="cancel-btn"
                  title="Dismiss without choice"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    elicitationRequest.reject();
                    setElicitationRequest(null);
                    setFormData({});
                  }}
                  className="decline-btn"
                  title="Explicitly reject request"
                >
                  Decline
                </button>
                <button
                  type="submit"
                  className="submit-btn"
                  title="Accept and submit data"
                >
                  Accept
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
