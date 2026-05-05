import { useState } from "react";
import { Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { CodeExplanation, type CodeSection } from "../../components";

type TransportId = "streamable-http" | "sse" | "rpc";

const transports: Array<{
  id: TransportId;
  name: string;
  bestFor: string;
  tradeoff: string;
  flow: string[];
}> = [
  {
    id: "streamable-http",
    name: "Streamable HTTP",
    bestFor: "Public MCP servers and most new integrations",
    tradeoff: "Needs an HTTP route and auth story, but works across clients",
    flow: [
      "Client calls addMcpServer(url)",
      "Agent negotiates Streamable HTTP",
      "Tools/resources are discovered",
      "Tool calls stream over HTTP"
    ]
  },
  {
    id: "sse",
    name: "SSE",
    bestFor: "Older MCP clients or servers that have not moved yet",
    tradeoff: "Still supported, but usually not the first choice for new work",
    flow: [
      "Client points at an SSE endpoint",
      "Server opens an event stream",
      "Client sends tool calls over paired HTTP requests",
      "Agent tracks server state"
    ]
  },
  {
    id: "rpc",
    name: "Durable Object RPC",
    bestFor: "MCP server and client live in the same Worker",
    tradeoff: "Not an internet protocol, but avoids HTTP hops and secrets",
    flow: [
      "Agent receives a Durable Object binding",
      "addMcpServer connects through RPC",
      "Tools run in-process across DO boundaries",
      "No public MCP URL is required"
    ]
  }
];

const advancedPatterns = [
  {
    title: "Elicitation",
    description:
      "A tool can pause and ask the user for structured input before it continues. This is ideal for approvals, environment selection, missing fields, or scoped permissions.",
    snippet: `export class DeployMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Deploy", version: "1.0.0" });

  async init() {
    this.server.registerTool("deploy", { inputSchema }, async (args) => {
      const approval = await this.elicitInput({
        message: "Deploy to production?",
        requestedSchema: approvalSchema
      });

      if (approval.action !== "accept") {
        return { content: [{ type: "text", text: "Cancelled" }] };
      }

      return deploy(args);
    });
  }
}`
  },
  {
    title: "Authenticated MCP Server",
    description:
      "Wrap a server with OAuth when tools need user identity. The agent can inspect auth context and expose only the tools/resources the user should see.",
    snippet: `import { createMcpHandler, getMcpAuthContext } from "agents/mcp";

server.registerTool("whoami", { description: "Who am I?" }, async () => {
  const auth = getMcpAuthContext();
  return {
    content: [{ type: "text", text: JSON.stringify(auth?.props) }]
  };
});

return createMcpHandler(server)(request, env, ctx);`
  },
  {
    title: "Codemode MCP",
    description:
      "Collapse a large API surface into a single code tool. This lets the model write small programs against a typed tool provider instead of choosing from dozens of narrow tools.",
    snippet: `import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { codeMcpServer } from "@cloudflare/codemode/mcp";
import { createMcpHandler } from "agents/mcp";

const upstream = createUpstreamServer();
const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
const server = await codeMcpServer({ server: upstream, executor });

return createMcpHandler(server, { route: "/codemode" })(
  request,
  env,
  ctx
);`
  },
  {
    title: "Paid Tools with x402",
    description:
      "Add payment requirements to expensive MCP tools. The client can confirm or reject the payment before the call proceeds.",
    snippet: `import { withX402 } from "agents/x402";

const server = withX402(new McpServer({ name: "PayMCP" }), config);

server.paidTool(
  "search_pro",
  "Deep search",
  0.01,
  schema,
  {},
  async (args) => {
    return search(args);
  });
);`
  }
];

const codeSections: CodeSection[] = [
  {
    title: "Choose the transport deliberately",
    description:
      "The same MCP server shape can be reached through HTTP, SSE, or in-process Durable Object RPC. The right transport depends on where the client and server live.",
    code: `// External server over HTTP
await this.addMcpServer("docs", "https://mcp.example.com/mcp", {
  transport: { type: "streamable-http" },
});

// Legacy SSE endpoint
await this.addMcpServer("legacy", "https://mcp.example.com/sse", {
  transport: { type: "sse" },
});

// Same Worker, no public URL
await this.addMcpServer("internal", env.InternalMcpServer, {
  props: { tenantId },
});`
  },
  {
    title: "Keep OAuth state in the agent",
    description:
      "MCP OAuth belongs in Durable Object storage so token exchange, reconnect, and refresh survive restarts.",
    code: `const result = await this.addMcpServer("github", serverUrl, {
  callbackHost: new URL(request.url).origin,
});

if (result.state === "authenticating") {
  this.broadcast(JSON.stringify({
    type: "mcp_auth_required",
    authUrl: result.authUrl,
  }));
}`
  },
  {
    title: "Expose advanced cases as links when setup is heavy",
    description:
      "Some MCP stories need real OAuth providers, wallets, or browser support. The Playground should explain them clearly and link to focused examples for full setup.",
    code: `// Good Playground shape
// 1. Show the decision and code path
// 2. Simulate the state transitions
// 3. Link to the standalone example for credentials/setup`
  }
];

export function AdvancedMcpDemo() {
  const [selectedId, setSelectedId] = useState<TransportId>("streamable-http");
  const selected = transports.find((transport) => transport.id === selectedId);

  return (
    <DemoWrapper
      title="Advanced MCP"
      description={
        <>
          MCP in the Agents SDK is more than connecting to one server. Agents
          can host MCP, consume external servers, use OAuth, run in-process RPC,
          prompt users mid-tool-call with elicitation, wrap APIs with codemode,
          and protect expensive tools with x402 payments.
        </>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3" as="h3">
                Transport Matrix
              </Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-4">
              Pick a transport to see when it is the right fit. Most product
              apps use Streamable HTTP for external servers and RPC when both
              sides are Durable Objects in the same Worker.
            </p>
            <div className="grid grid-cols-1 gap-2">
              {transports.map((transport) => (
                <button
                  key={transport.id}
                  type="button"
                  onClick={() => setSelectedId(transport.id)}
                  className={`text-left p-3 rounded border transition-colors ${
                    selectedId === transport.id
                      ? "border-kumo-brand bg-kumo-elevated"
                      : "border-kumo-line hover:border-kumo-interact"
                  }`}
                >
                  <Text bold size="sm">
                    {transport.name}
                  </Text>
                  <p className="mt-1 text-xs text-kumo-subtle">
                    {transport.bestFor}
                  </p>
                </button>
              ))}
            </div>
          </Surface>

          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3" as="h3">
                What This Unlocks
              </Text>
            </div>
            <div className="space-y-3">
              {advancedPatterns.map((pattern) => (
                <div
                  key={pattern.title}
                  className="p-3 rounded bg-kumo-elevated"
                >
                  <Text bold size="sm">
                    {pattern.title}
                  </Text>
                  <p className="mt-1 text-xs text-kumo-subtle">
                    {pattern.description}
                  </p>
                </div>
              ))}
            </div>
          </Surface>
        </div>

        <div className="space-y-6">
          {selected && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-4">
                <Text variant="heading3" as="h3">
                  {selected.name} Flow
                </Text>
              </div>
              <div className="mb-4 p-3 rounded bg-kumo-elevated">
                <Text bold size="sm">
                  Best for
                </Text>
                <p className="mt-1 text-sm text-kumo-subtle">
                  {selected.bestFor}
                </p>
              </div>
              <div className="mb-4 p-3 rounded bg-kumo-elevated">
                <Text bold size="sm">
                  Tradeoff
                </Text>
                <p className="mt-1 text-sm text-kumo-subtle">
                  {selected.tradeoff}
                </p>
              </div>
              <ol className="space-y-2">
                {selected.flow.map((step, index) => (
                  <li key={step} className="flex gap-3 text-sm">
                    <span className="w-6 h-6 rounded-full bg-kumo-fill text-kumo-subtle flex items-center justify-center text-xs shrink-0">
                      {index + 1}
                    </span>
                    <span className="text-kumo-default">{step}</span>
                  </li>
                ))}
              </ol>
            </Surface>
          )}

          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3" as="h3">
                Focused Examples to Open Next
              </Text>
            </div>
            <div className="space-y-2">
              {[
                ["RPC transport", "examples/mcp-rpc-transport"],
                ["Elicitation", "examples/mcp-elicitation"],
                ["OAuth server", "examples/mcp-worker-authenticated"],
                ["Codemode MCP", "examples/codemode-mcp"],
                ["OpenAPI MCP", "examples/codemode-mcp-openapi"],
                ["x402 MCP", "examples/x402-mcp"],
                ["WebMCP", "examples/webmcp"]
              ].map(([label, path]) => (
                <div
                  key={path}
                  className="flex items-center justify-between gap-3 p-3 rounded bg-kumo-elevated"
                >
                  <Text size="sm" bold>
                    {label}
                  </Text>
                  <code className="text-xs text-kumo-subtle">{path}</code>
                </div>
              ))}
            </div>
          </Surface>
        </div>
      </div>

      <Surface className="mt-6 p-4 rounded-lg ring ring-kumo-line">
        <div className="mb-3">
          <Text variant="heading3" as="h3">
            Pattern Snippets
          </Text>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {advancedPatterns.map((pattern) => (
            <Surface
              key={pattern.title}
              className="p-3 rounded bg-kumo-elevated"
            >
              <Text bold size="sm">
                {pattern.title}
              </Text>
              <pre className="mt-3 p-3 rounded bg-kumo-base border border-kumo-line overflow-x-auto text-xs">
                <code>{pattern.snippet}</code>
              </pre>
            </Surface>
          ))}
        </div>
      </Surface>

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
