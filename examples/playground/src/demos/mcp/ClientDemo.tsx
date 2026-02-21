import { Surface, Text, CodeBlock } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { CodeExplanation, type CodeSection } from "../../components";

const codeSections: CodeSection[] = [
  {
    title: "Connect to external MCP servers",
    description:
      "Use this.addMcpServer() to connect your agent to any MCP server. The connection persists across restarts — the agent automatically reconnects.",
    code: `import { McpClientAgent } from "agents/mcp";

class MyAgent extends McpClientAgent<Env> {
  async onStart() {
    await this.addMcpServer("weather", "https://weather-mcp.example.com", {
      transport: "sse",
      headers: { Authorization: "Bearer token" },
    });
  }
}`
  },
  {
    title: "Use MCP tools with AI",
    description:
      "Call mcp.getAITools() to convert all connected MCP tools into AI SDK format. Pass them directly to streamText or generateText.",
    code: `  async onChatMessage(onFinish) {
    const mcpTools = await this.mcp.getAITools();

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      messages: this.messages,
      tools: mcpTools,
      onFinish,
    });
    return result.toDataStreamResponse();
  }`
  }
];

export function McpClientDemo() {
  return (
    <DemoWrapper
      title="MCP Client"
      description={
        <>
          Your agent can connect to external MCP servers using{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            this.addMcpServer()
          </code>
          . Once connected, use{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            mcp.getAITools()
          </code>{" "}
          to convert their tools into AI SDK format and pass them directly to{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            streamText
          </code>
          . Connections persist across restarts — the agent automatically
          reconnects.
        </>
      }
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
      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
