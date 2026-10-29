import { Surface, Text, CodeBlock } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { CodeExplanation, type CodeSection } from "../../components";

const FLOW_DESCRIPTION = `
1. Client calls addMcpServer with OAuth-protected URL
2. Agent detects OAuth requirement, returns authUrl
3. Client opens authUrl in browser/popup
4. User authenticates with the MCP server's OAuth provider
5. OAuth provider redirects to agent's /callback endpoint
6. Agent exchanges code for tokens, stores them
7. Agent connects to MCP server with tokens
8. Client is notified of successful connection
`;

const codeSections: CodeSection[] = [
  {
    title: "Connect to OAuth-protected MCP servers",
    description:
      "When an MCP server requires OAuth, addMcpServer returns the link to send the user to. The agent finishes the flow on its /callback endpoint and every connected client sees the server move to ready.",
    code: `// Server: add the server from a callable. Calling it again returns the
// link still waiting, or reconnects a server that isn't connected.
@callable()
async connect(url: string) {
  return this.addMcpServer("oauth-server", url, { id: "oauth-server" });
}

// Client
const result = await agent.call("connect", [serverUrl]);
if (result.state === "authenticating") {
  window.open(result.authUrl, "_blank");
}`
  },
  {
    title: "Show every server's state",
    description:
      "onMcpUpdate delivers getMcpServers() whenever a server changes. Render from it: the link while a server is authenticating, the error and a Reconnect button when it failed.",
    code: `const agent = useAgent({
  agent: "my-agent",
  name: "demo",
  onMcpUpdate: ({ servers }) => {
    for (const [id, server] of Object.entries(servers)) {
      if (server.state === "authenticating" && server.auth_url) {
        showAuthorizeLink(id, server.auth_url);
      } else if (server.state === "failed") {
        showError(id, server.error); // with a Reconnect button
      }
    }
  }
});`
  },
  {
    title: "Re-authorization and reconnecting",
    description:
      "A tool call can need the user again: a scope step-up, or a token that can no longer be refreshed. A server that stopped (authorization refused or expired, reconnects gave up) stays failed until someone reconnects it.",
    code: `import { MCPAuthorizationRequiredError } from "agents/mcp/client";

try {
  return await this.mcp.callTool({ serverId, name, arguments: args });
} catch (error) {
  if (error instanceof MCPAuthorizationRequiredError) {
    return { authorizationRequired: true, authUrl: error.authUrl };
  }
  throw error;
}

// The Reconnect button
@callable()
async reconnect(serverId: string) {
  return this.reconnectMcpServer(serverId);
}`
  }
];

export function McpOAuthDemo() {
  return (
    <DemoWrapper
      title="MCP OAuth"
      description={
        <>
          Some MCP servers require OAuth authentication. The SDK handles the
          full flow automatically — detecting the requirement, generating an
          auth URL, exchanging codes for tokens, and storing them in Durable
          Object storage. On restart, saved tokens are reused and refreshed as
          needed.
        </>
      }
    >
      <div className="max-w-3xl space-y-6">
        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3" as="h3">
              OAuth Authentication Flow
            </Text>
          </div>
          <div className="mb-4">
            <Text variant="secondary" size="sm">
              Some MCP servers require OAuth authentication. The Agents SDK
              handles the OAuth flow, token storage, and automatic reconnection
              with saved tokens.
            </Text>
          </div>

          <div className="space-y-2 mt-6">
            {FLOW_DESCRIPTION.trim()
              .split("\n")
              .map((step, i) => (
                <div key={i} className="flex gap-3 text-sm">
                  <span className="text-kumo-subtle">{step.trim()}</span>
                </div>
              ))}
          </div>
        </Surface>

        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3" as="h3">
              Server States
            </Text>
          </div>
          <div className="space-y-2">
            {[
              {
                state: "not-connected",
                desc: "Stored, with no live connection yet (for example right after a wake)"
              },
              { state: "connecting", desc: "Establishing connection" },
              {
                state: "authenticating",
                desc: "Waiting for the user to open auth_url and approve"
              },
              { state: "discovering", desc: "Fetching server capabilities" },
              { state: "ready", desc: "Connected and ready to use" },
              {
                state: "failed",
                desc: "Retrying in the background, or stopped with a reason until reconnectMcpServer()"
              }
            ].map(({ state, desc }) => (
              <div
                key={state}
                className="flex items-center gap-3 py-2 px-3 bg-kumo-elevated rounded"
              >
                <code className="text-xs font-mono bg-kumo-control px-2 py-0.5 rounded text-kumo-default">
                  {state}
                </code>
                <Text variant="secondary" size="sm">
                  {desc}
                </Text>
              </div>
            ))}
          </div>
        </Surface>

        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3" as="h3">
              Client-Side Handling
            </Text>
          </div>
          <CodeBlock
            lang="ts"
            code={`const result = await agent.call("connect", [url]);
if (result.state === "authenticating") {
  // Open the link in a popup; the agent's callback can close it
  window.open(result.authUrl, "_blank");
}

const agent = useAgent({
  agent: "my-agent",
  name: "demo",
  onMcpUpdate: ({ servers }) => {
    const server = servers["oauth-server"];
    if (server?.state === "ready") {
      console.log("Connected");
    }
  }
});`}
          />
        </Surface>

        <Surface className="p-4 rounded-lg bg-kumo-elevated">
          <Text variant="secondary" size="sm">
            <strong className="text-kumo-default">Token Storage:</strong> OAuth
            tokens are stored in the agent's Durable Object storage, refreshed
            as needed, and reused after a restart. When a refresh is refused the
            server asks the user again; a link nobody completes expires after 10
            minutes.
          </Text>
        </Surface>
      </div>
      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
