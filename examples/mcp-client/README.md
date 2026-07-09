# MCP Client

An Agent that acts as an MCP **client** — dynamically connects to remote MCP servers, handles OAuth authentication, and aggregates tools, prompts, and resources from all connected servers.

## What it demonstrates

- **`addMcpServer` / `removeMcpServer`** — managing MCP server connections from an Agent
- **`onMcpUpdate`** — real-time state updates pushed to the React frontend via WebSocket
- **`this.mcp.configureElicitationHandler`** — when a server requests input mid-tool-call (elicitation), the Agent broadcasts it to the browser, which renders a form from the request's schema (or a link for url-mode); the human's answer resolves the pending tool call via a `@callable` method
- **OAuth popup flow** — `configureOAuthCallback` with a custom handler that closes the popup after auth
- **`agentFetch`** — making HTTP requests to the Agent's custom endpoints from the client

## Running

```sh
npm install
npm run dev
```

The UI lets you add MCP server URLs, see their connection state, browse their tools, prompts, and resources, and run tools. If a tool call triggers an elicitation, a card appears asking for your input.

To test with an authenticated server, run the [`mcp-worker-authenticated`](../mcp-worker-authenticated/) example alongside this one and add its URL. To test elicitation, run the [`mcp-elicitation`](../mcp-elicitation/) example's server, add it here (the MCP endpoint is at `/mcp`, e.g. `http://localhost:8787/mcp`), and run its `increase-counter` (form-mode) or `connect-account` (url-mode) tool from this UI.

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

  async onRequest(request) {
    // Custom endpoints for the frontend
    if (url.pathname.endsWith("add-mcp")) {
      const { name, url } = await request.json();
      await this.addMcpServer(name, url);
      return new Response("Ok");
    }
  }
}
```

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
