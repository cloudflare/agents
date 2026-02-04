import { useAgent } from "agents/react";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import type { MCPServersState } from "agents";
import { agentFetch } from "agents/client";
import { nanoid } from "nanoid";

let sessionId = localStorage.getItem("sessionId");
if (!sessionId) {
  sessionId = nanoid(8);
  localStorage.setItem("sessionId", sessionId);
}
// TODO: clear sessionId on logout

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const mcpUrlInputRef = useRef<HTMLInputElement>(null);
  const mcpNameInputRef = useRef<HTMLInputElement>(null);
  const [mcpState, setMcpState] = useState<MCPServersState>({
    prompts: [],
    resources: [],
    servers: {},
    tools: []
  });

  const agent = useAgent({
    agent: "my-agent",
    name: sessionId!,
    onClose: () => setIsConnected(false),
    onMcpUpdate: (mcpServers: MCPServersState) => {
      setMcpState(mcpServers);
    },
    onOpen: () => setIsConnected(true)
  });

  function openPopup(authUrl: string) {
    window.open(
      authUrl,
      "popupWindow",
      "width=600,height=800,resizable=yes,scrollbars=yes,toolbar=yes,menubar=no,location=no,directories=no,status=yes"
    );
  }

  const handleMcpSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!mcpUrlInputRef.current || !mcpUrlInputRef.current.value.trim()) return;
    const serverUrl = mcpUrlInputRef.current.value;

    if (!mcpNameInputRef.current || !mcpNameInputRef.current.value.trim())
      return;
    const serverName = mcpNameInputRef.current.value;
    agentFetch(
      {
        agent: "my-agent",
        host: agent.host,
        name: sessionId!,
        path: "add-mcp"
      },
      {
        body: JSON.stringify({ name: serverName, url: serverUrl }),
        method: "POST"
      }
    );
    setMcpState({
      ...mcpState,
      servers: {
        ...mcpState.servers,
        placeholder: {
          auth_url: null,
          capabilities: null,
          error: null,
          instructions: null,
          name: serverName,
          server_url: serverUrl,
          state: "connecting"
        }
      }
    });
  };

  const handleDisconnect = async (serverId: string) => {
    await agentFetch(
      {
        agent: "my-agent",
        host: agent.host,
        name: sessionId!,
        path: "disconnect-mcp"
      },
      {
        body: JSON.stringify({ serverId }),
        method: "POST"
      }
    );
  };

  const handleGetTools = async (serverId: string) => {
    try {
      const response = await agentFetch(
        {
          agent: "my-agent",
          host: agent.host,
          name: sessionId!,
          path: "get-tools"
        },
        {
          body: JSON.stringify({ serverId }),
          method: "POST"
        }
      );
      // biome-ignore lint/suspicious/noExplicitAny: just a demo
      const data = (await response.json()) as { tools: any[]; error?: string };

      if (data.error) {
        throw new Error(data.error);
      }

      console.log("Server tools:", data.tools);
      alert(`Server Tools:\n\n${JSON.stringify(data.tools, null, 2)}`);
    } catch (error) {
      console.error("Failed to get tools:", error);
      alert(
        `Failed to get tools: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  return (
    <div className="container">
      <div className="status-indicator">
        <div className={`status-dot ${isConnected ? "connected" : ""}`} />
        {isConnected ? "Connected to server" : "Disconnected"}
      </div>

      <div className="mcp-servers">
        <form className="mcp-form" onSubmit={handleMcpSubmit}>
          <input
            type="text"
            ref={mcpNameInputRef}
            className="mcp-input name"
            placeholder="MCP Server Name"
          />
          <input
            type="text"
            ref={mcpUrlInputRef}
            className="mcp-input url"
            placeholder="MCP Server URL"
          />
          <button type="submit">Add MCP Server</button>
        </form>
      </div>

      <div className="mcp-section">
        <h2>MCP Servers</h2>
        {Object.entries(mcpState.servers).map(([id, server]) => (
          <div key={id} className={"mcp-server"}>
            <div>
              <b>{server.name}</b> <span>({server.server_url})</span>
              <div className="status-indicator">
                <div
                  className={`status-dot ${server.state === "ready" ? "connected" : ""}`}
                />
                {server.state} (id: {id})
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              {server.state === "authenticating" && server.auth_url && (
                <button
                  type="button"
                  onClick={() => openPopup(server.auth_url as string)}
                >
                  Authorize
                </button>
              )}
              {server.state === "ready" && (
                <button type="button" onClick={() => handleGetTools(id)}>
                  List Tools
                </button>
              )}
              <button type="button" onClick={() => handleDisconnect(id)}>
                Disconnect
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="messages-section">
        <h2>Server Data</h2>
        <h3>Tools</h3>
        {mcpState.tools.map((tool) => (
          <div key={`${tool.name}-${tool.serverId}`}>
            <b>{tool.name}</b>
            <pre className="code">{JSON.stringify(tool, null, 2)}</pre>
          </div>
        ))}

        <h3>Prompts</h3>
        {mcpState.prompts.map((prompt) => (
          <div key={`${prompt.name}-${prompt.serverId}`}>
            <b>{prompt.name}</b>
            <pre className="code">{JSON.stringify(prompt, null, 2)}</pre>
          </div>
        ))}

        <h3>Resources</h3>
        {mcpState.resources.map((resource) => (
          <div key={`${resource.name}-${resource.serverId}`}>
            <b>{resource.name}</b>
            <pre className="code">{JSON.stringify(resource, null, 2)}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
