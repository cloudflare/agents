import { Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";

export function McpServerDemo() {
  return (
    <DemoWrapper
      title="MCP Server"
      description="Create MCP (Model Context Protocol) servers with tools, resources, and prompts."
    >
      <div className="max-w-3xl space-y-6">
        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">What is MCP?</Text>
          </div>
          <div className="mb-4">
            <Text variant="secondary" size="sm">
              The Model Context Protocol (MCP) is an open standard for
              connecting AI assistants to external data sources and tools. Your
              agent can become an MCP server, allowing any MCP-compatible AI
              (like Claude, Cursor, or custom apps) to use its capabilities.
            </Text>
          </div>

          <div className="grid grid-cols-3 gap-4 mt-6">
            <div className="text-center p-4 bg-kumo-elevated rounded">
              <div className="text-2xl mb-2">🔧</div>
              <Text bold size="sm">
                Tools
              </Text>
              <div className="mt-1">
                <Text variant="secondary" size="xs">
                  Functions the AI can call
                </Text>
              </div>
            </div>
            <div className="text-center p-4 bg-kumo-elevated rounded">
              <div className="text-2xl mb-2">📄</div>
              <Text bold size="sm">
                Resources
              </Text>
              <div className="mt-1">
                <Text variant="secondary" size="xs">
                  Data the AI can read
                </Text>
              </div>
            </div>
            <div className="text-center p-4 bg-kumo-elevated rounded">
              <div className="text-2xl mb-2">💬</div>
              <Text bold size="sm">
                Prompts
              </Text>
              <div className="mt-1">
                <Text variant="secondary" size="xs">
                  Pre-built prompt templates
                </Text>
              </div>
            </div>
          </div>
        </Surface>

        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">How It Works</Text>
          </div>
          <ol className="space-y-3 text-sm text-kumo-subtle">
            {[
              ["Extend ", "McpAgent", " instead of ", "Agent"],
              ["Create an ", "McpServer", " instance with name and version"],
              [
                "Register tools, resources, and prompts in the ",
                "init()",
                " method"
              ],
              ["Deploy - the agent automatically handles MCP protocol"]
            ].map((parts, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-kumo-contrast text-kumo-inverse flex items-center justify-center text-xs shrink-0">
                  {i + 1}
                </span>
                <span>
                  {parts.map((part, j) =>
                    j % 2 === 1 ? (
                      <code
                        key={j}
                        className="bg-kumo-control px-1 rounded text-kumo-default"
                      >
                        {part}
                      </code>
                    ) : (
                      <span key={j}>{part}</span>
                    )
                  )}
                </span>
              </li>
            ))}
          </ol>
        </Surface>

        <Surface className="p-4 rounded-lg bg-kumo-elevated">
          <Text variant="secondary" size="sm">
            <strong className="text-kumo-default">See also:</strong> The MCP
            Client demo shows how to connect your agent to external MCP servers.
          </Text>
        </Surface>
      </div>
    </DemoWrapper>
  );
}
