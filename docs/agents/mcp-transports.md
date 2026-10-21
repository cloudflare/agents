# MCP Transports

This page covers the transport your MCP server uses and the transports an Agent can use to connect to other MCP servers.

## Server: Streamable HTTP

[`createMcpHandler`](./mcp-servers.md) serves Streamable HTTP. Each request is handled on its own, with a fresh `McpServer` from your factory, so there are no sessions, Durable Objects, or WebSockets behind the endpoint.

```typescript
import { createMcpHandler } from "agents/mcp/server";

const handler = createMcpHandler(createServer, { route: "/mcp" });
```

The same endpoint serves:

- Stateless clients on draft MCP `2026-07-28`
- 2025-era Streamable HTTP clients, for tools, resources, and prompts (the default `legacy: "stateless"` lane)

It does not serve the standalone SSE transport. Set `legacy: "reject"` to accept only Stateless clients. See [2025-era clients](./mcp-servers.md#2025-era-clients) for what that lane does not support.

## Client: connecting to MCP servers

An Agent connects to remote MCP servers with `addMcpServer()`. The `transport.type` option picks the transport:

```typescript
// Default: try Streamable HTTP, fall back to SSE
await this.addMcpServer("my-server", "https://example.com/mcp");

// Force a transport
await this.addMcpServer("my-server", "https://example.com/mcp", {
  transport: { type: "streamable-http" }
});

// Send extra headers, for example an API key
await this.addMcpServer("my-server", "https://example.com/mcp", {
  transport: {
    type: "streamable-http",
    headers: { Authorization: `Bearer ${this.env.API_KEY}` }
  }
});
```

| `transport.type`    | Use when                                          |
| ------------------- | ------------------------------------------------- |
| `"auto"` (default)  | You do not know which transport the server speaks |
| `"streamable-http"` | The server supports Streamable HTTP               |
| `"sse"`             | The server only supports the older SSE transport  |

`"auto"` tries Streamable HTTP first and falls back to SSE only when the server reports that Streamable HTTP is unsupported. The client negotiates the protocol version on every connection, so it works with both Stateless and 2025-era servers. See [Connecting to MCP Servers](./mcp-client.md) for OAuth, retries, and the rest of the client API.

## Examples

- [`examples/mcp-worker`](https://github.com/cloudflare/agents/tree/main/examples/mcp-worker): a server built with `createMcpHandler`
- [`examples/mcp-client`](https://github.com/cloudflare/agents/tree/main/examples/mcp-client): an Agent that connects to MCP servers
