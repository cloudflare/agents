import { Surface, Text, CodeBlock } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";

export function McpClientDemo() {
  return (
    <DemoWrapper
      title="MCP Client"
      description="Connect your agent to external MCP servers to access their tools and resources."
    >
      <div className="max-w-3xl space-y-6">
        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">Connecting to External MCP Servers</Text>
          </div>
          <div className="mb-4">
            <Text variant="secondary" size="sm">
              Your agent can connect to external MCP servers to access their
              tools, resources, and prompts. This allows your agent to leverage
              capabilities from other services while maintaining a unified
              interface.
            </Text>
          </div>

          <div className="space-y-3 mt-6">
            {[
              {
                method: "addMcpServer(name, url, options?)",
                desc: "Register and connect to an MCP server. Supports SSE and Streamable HTTP transports."
              },
              {
                method: "mcp.listTools()",
                desc: "Get all tools from all connected servers."
              },
              {
                method: "mcp.callTool({ serverId, name, arguments })",
                desc: "Execute a tool on a connected server."
              },
              {
                method: "mcp.getAITools()",
                desc: "Convert MCP tools to AI SDK format for use with streamText/generateText."
              }
            ].map(({ method, desc }) => (
              <div key={method} className="p-3 bg-kumo-elevated rounded">
                <Text bold size="sm">
                  {method}
                </Text>
                <div className="mt-1">
                  <Text variant="secondary" size="xs">
                    {desc}
                  </Text>
                </div>
              </div>
            ))}
          </div>
        </Surface>

        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">Connection Options</Text>
          </div>
          <CodeBlock
            lang="ts"
            code={`await this.addMcpServer("server-name", "https://...", {
  // Transport type
  transport: "sse" | "streamable-http" | "auto",
  
  // Custom headers (e.g., for authentication)
  headers: {
    "Authorization": "Bearer token"
  }
});`}
          />
        </Surface>

        <Surface className="p-4 rounded-lg bg-kumo-elevated">
          <Text variant="secondary" size="sm">
            <strong className="text-kumo-default">Note:</strong> MCP connections
            persist across agent restarts. The agent automatically reconnects to
            previously added servers.
          </Text>
        </Surface>
      </div>
    </DemoWrapper>
  );
}
