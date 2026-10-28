# MCP Client

An Agent that acts as an MCP **client** — dynamically connects to remote MCP servers, handles OAuth authentication, and aggregates tools, prompts, and resources from all connected servers.

## What it demonstrates

- **`addMcpServer` / `removeMcpServer`** — managing MCP server connections from an Agent
- **`onMcpUpdate`** — real-time state updates pushed to the React frontend via WebSocket
- **`this.mcp.configureElicitationHandlers`** — handles both Stateless Elicitation (`input_required` through MRTR) and Legacy Elicitation (pushed `elicitation/create`); the Agent broadcasts requests to the browser and the human's answer resolves the pending operation via a `@callable` method
- **OAuth popup flow** — `configureOAuthCallback` with a custom handler that closes the popup after auth
- **Re-authorization during a session** — a tool call that needs the user to authorize again (a scope step-up, or a token that can no longer be refreshed) catches `MCPAuthorizationRequiredError` and opens the new link
- **`reconnectMcpServer`** — a "Reconnect" button for a server that stopped (reconnects gave up, authorization was refused or expired). `addMcpServer` for a registered server only reports its state, so it is safe to call again

## Running

```sh
npm install
npm run start
```

The UI lets you add MCP server URLs, see their connection state, browse their tools, prompts, and resources, and run tools. If a tool call triggers an elicitation, a card appears asking for your input.

To test with an authenticated server, run [`mcp-worker-authenticated`](../mcp-worker-authenticated/) alongside this example and add its URL. For **Stateless Elicitation**, run [`mcp-elicitation-mrtr`](../mcp-elicitation-mrtr/) and call `increase-counter`. To test pushed form- and URL-mode **Legacy Elicitation**, run [`mcp-elicitation`](../mcp-elicitation/). Each endpoint is `/mcp` (for example, `http://localhost:8787/mcp`).

## Environment variables

Copy `.env.example` to `.env` if you need to override the OAuth callback host:

```sh
cp .env.example .env
```

## How it works

### Server side

The Agent manages MCP connections via the built-in `mcp` property:

```typescript
export class MyAgent extends Agent {
  onStart() {
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" }
          });
        }
        return new Response(`Auth failed: ${result.authError}`, {
          status: 400
        });
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    await this.addMcpServer(name, url);
  }

  @callable()
  async reconnectServer(serverId: string) {
    // Returns a new authUrl when the server needs the user again
    return await this.reconnectMcpServer(serverId);
  }

  @callable()
  async callTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>
  ) {
    try {
      return await this.mcp.callTool({ serverId, name, arguments: args });
    } catch (error) {
      if (error instanceof MCPAuthorizationRequiredError) {
        return { authorizationRequired: true, authUrl: error.authUrl };
      }
      throw error;
    }
  }
}
```

The browser renders each server from the `cf_agent_mcp_servers` state: an **Authorize** button while it is `authenticating` with an `auth_url`, and the error with a **Reconnect** button while it is `failed`.

### Client side

The React frontend uses `useAgent` with `onMcpUpdate` to receive real-time server state:

```typescript
const agent = useAgent({
  agent: "my-agent",
  name: sessionId,
  onMcpUpdate: (mcpServers) => setMcpState(mcpServers),
  onOpen: () => setConnected(true)
});
```

## Related examples

- [`mcp`](../mcp/) — stateful MCP server (good target to connect to)
- [`mcp-worker-authenticated`](../mcp-worker-authenticated/) — authenticated server (tests the OAuth flow)
