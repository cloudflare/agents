import { DemoWrapper } from "../../layout";

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

export function McpOAuthDemo() {
  return (
    <DemoWrapper
      title="MCP OAuth"
      description="Connect to OAuth-protected MCP servers with automatic token management."
    >
      <div className="max-w-3xl space-y-6">
        <div className="card p-6">
          <h3 className="font-semibold text-lg mb-4">
            OAuth Authentication Flow
          </h3>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
            Some MCP servers require OAuth authentication. The Agents SDK
            handles the OAuth flow, token storage, and automatic reconnection
            with saved tokens.
          </p>

          <div className="space-y-2 mt-6">
            {FLOW_DESCRIPTION.trim()
              .split("\n")
              .map((step, i) => (
                <div key={i} className="flex gap-3 text-sm">
                  <span className="text-neutral-500 dark:text-neutral-400">
                    {step.trim()}
                  </span>
                </div>
              ))}
          </div>
        </div>

        <div className="card p-6">
          <h3 className="font-semibold text-lg mb-4">Server States</h3>
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
                className="flex items-center gap-3 py-2 px-3 bg-neutral-50 dark:bg-neutral-800 rounded"
              >
                <code className="text-xs font-mono bg-neutral-200 dark:bg-neutral-700 px-2 py-0.5 rounded">
                  {state}
                </code>
                <span className="text-sm text-neutral-600 dark:text-neutral-400">
                  {desc}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="card p-6">
          <h3 className="font-semibold text-lg mb-4">Client-Side Handling</h3>
          <pre className="text-xs bg-neutral-50 dark:bg-neutral-900 p-4 rounded overflow-x-auto">
            {`// Check if OAuth is needed
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
          </pre>
        </div>

        <div className="card p-4 bg-neutral-50 dark:bg-neutral-800">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            <strong>Token Storage:</strong> OAuth tokens are stored in the
            agent's Durable Object storage and automatically used for
            reconnection. Tokens are refreshed as needed.
          </p>
        </div>
      </div>
    </DemoWrapper>
  );
}
