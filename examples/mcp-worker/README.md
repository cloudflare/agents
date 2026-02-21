# MCP Server (createMcpHandler)

The simplest way to run a stateless MCP server on Cloudflare Workers. Uses `createMcpHandler` from the Agents SDK to handle all MCP protocol details in one line.

## What it demonstrates

- **`createMcpHandler`** — the Agents SDK helper that wraps an `McpServer` into a Worker-compatible fetch handler
- **Minimal setup** — define tools on an `McpServer`, pass it to `createMcpHandler`, done
- **Stateless** — no Durable Objects, no persistent state, each request is independent

## Running

```sh
npm install
npm run dev
```

Open the browser to see the built-in tool tester, or connect with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at `http://localhost:5173/mcp`.

## How it works

```typescript
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function createServer() {
  const server = new McpServer({ name: "Hello MCP Server", version: "1.0.0" });
  server.registerTool(
    "hello",
    {
      description: "Returns a greeting",
      inputSchema: { name: z.string().optional() }
    },
    async ({ name }) => ({
      content: [{ type: "text", text: `Hello, ${name ?? "World"}!` }]
    })
  );
  return server;
}

export default {
  fetch: async (request, env, ctx) => {
    const server = createServer();
    return createMcpHandler(server)(request, env, ctx);
  }
};
```

## Related examples

- [`mcp`](../mcp/) — stateful MCP server with `McpAgent` and Durable Objects
- [`mcp-worker-authenticated`](../mcp-worker-authenticated/) — adding OAuth authentication
- [`mcp-client`](../mcp-client/) — connecting to MCP servers as a client
