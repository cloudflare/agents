import { DemoWrapper } from "../../layout";

export function McpClientDemo() {
  return (
    <DemoWrapper
      title="MCP Client"
      description="Connect your agent to external MCP servers to access their tools and resources."
    >
      <div className="max-w-3xl space-y-6">
        <div className="card p-6">
          <h3 className="font-semibold text-lg mb-4">
            Connecting to External MCP Servers
          </h3>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
            Your agent can connect to external MCP servers to access their
            tools, resources, and prompts. This allows your agent to leverage
            capabilities from other services while maintaining a unified
            interface.
          </p>

          <div className="space-y-3 mt-6">
            <div className="p-3 bg-neutral-50 dark:bg-neutral-800 rounded">
              <h4 className="font-medium text-sm">
                addMcpServer(name, url, options?)
              </h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                Register and connect to an MCP server. Supports SSE and
                Streamable HTTP transports.
              </p>
            </div>
            <div className="p-3 bg-neutral-50 dark:bg-neutral-800 rounded">
              <h4 className="font-medium text-sm">mcp.listTools()</h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                Get all tools from all connected servers.
              </p>
            </div>
            <div className="p-3 bg-neutral-50 dark:bg-neutral-800 rounded">
              <h4 className="font-medium text-sm">
                mcp.callTool(&#123; serverId, name, arguments &#125;)
              </h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                Execute a tool on a connected server.
              </p>
            </div>
            <div className="p-3 bg-neutral-50 dark:bg-neutral-800 rounded">
              <h4 className="font-medium text-sm">mcp.getAITools()</h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                Convert MCP tools to AI SDK format for use with
                streamText/generateText.
              </p>
            </div>
          </div>
        </div>

        <div className="card p-6">
          <h3 className="font-semibold text-lg mb-4">Connection Options</h3>
          <pre className="text-xs bg-neutral-50 dark:bg-neutral-900 p-4 rounded overflow-x-auto">
            {`await this.addMcpServer("server-name", "https://...", {
  // Transport type
  transport: "sse" | "streamable-http" | "auto",
  
  // Custom headers (e.g., for authentication)
  headers: {
    "Authorization": "Bearer token"
  }
});`}
          </pre>
        </div>

        <div className="card p-4 bg-neutral-50 dark:bg-neutral-800">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            <strong>Note:</strong> MCP connections persist across agent
            restarts. The agent automatically reconnects to previously added
            servers.
          </p>
        </div>
      </div>
    </DemoWrapper>
  );
}
