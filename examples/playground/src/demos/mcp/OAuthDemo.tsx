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
      "When an MCP server requires OAuth, the SDK handles the full flow — detecting the requirement, generating the auth URL, exchanging codes for tokens, and reconnecting.",
    code: `// Client-side: initiate OAuth connection
const result = await agent.call("connectWithOAuth", [serverUrl]);

if (result.needsAuth) {
  // Open the OAuth provider's login page
  window.open(result.authUrl, "_blank");
}

// Listen for connection updates
const agent = useAgent({
  agent: "my-agent",
  name: "demo",
  onMcpUpdate: (servers) => {
    const server = servers.find(s => s.id === "oauth-server");
    if (server?.state === "ready") {
      console.log("OAuth complete, connected!");
    }
  },
});`
  },
  {
    title: "Token management",
    description:
      "OAuth tokens are stored in the agent's Durable Object storage and automatically refreshed. The agent reconnects with saved tokens on restart.",
    code: `// Tokens are managed automatically:
// 1. Agent detects OAuth requirement
// 2. Client opens auth URL in browser
// 3. OAuth provider redirects to /callback
// 4. Agent exchanges code for tokens
// 5. Tokens stored in Durable Object storage
// 6. Agent connects with tokens
// 7. On restart, tokens are loaded and reused
// 8. Expired tokens are refreshed automatically`
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
            <Text variant="heading3">OAuth Authentication Flow</Text>
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
            <Text variant="heading3">Server States</Text>
          </div>
          <div className="space-y-2">
            {[
              {
                state: "not-connected",
                desc: "Server registered but not connected"
              },
              { state: "authenticating", desc: "Waiting for OAuth completion" },
              { state: "connecting", desc: "Establishing connection" },
              { state: "discovering", desc: "Fetching server capabilities" },
              { state: "ready", desc: "Connected and ready to use" },
              { state: "failed", desc: "Connection failed" }
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
            <Text variant="heading3">Client-Side Handling</Text>
          </div>
          <CodeBlock
            lang="ts"
            code={`// Check if OAuth is needed
const result = await agent.call("connectWithOAuth", [url]);

if (result.needsAuth) {
  // Open OAuth popup or redirect
  const popup = window.open(result.authUrl, "_blank");
  
  // Or redirect current page
  // window.location.href = result.authUrl;
}

// Listen for connection updates via onMcpUpdate
const agent = useAgent({
  agent: "my-agent",
  name: "demo",
  onMcpUpdate: (servers) => {
    console.log("MCP servers updated:", servers);
    // Check if OAuth server is now ready
    const oauthServer = servers.find(s => s.id === "oauth-server");
    if (oauthServer?.state === "ready") {
      console.log("OAuth complete, server connected!");
    }
  }
});`}
          />
        </Surface>

        <Surface className="p-4 rounded-lg bg-kumo-elevated">
          <Text variant="secondary" size="sm">
            <strong className="text-kumo-default">Token Storage:</strong> OAuth
            tokens are stored in the agent's Durable Object storage and
            automatically used for reconnection. Tokens are refreshed as needed.
          </Text>
        </Surface>
      </div>
      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
