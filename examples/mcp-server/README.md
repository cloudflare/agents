# Minimal MCP server on Cloudflare Workers

A stateless MCP server using the MCP SDK directly, without the Agents SDK. One factory and one handler serve Stateless clients and Legacy compatibility requests.

```ts
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

function createServer() {
  const server = new McpServer({
    name: "hello-server",
    version: "1.0.0"
  });

  server.registerTool(
    "hello",
    {
      description: "Returns a greeting",
      inputSchema: z.object({ name: z.string().optional() })
    },
    async ({ name }) => ({
      content: [{ type: "text", text: `Hello, ${name ?? "World"}!` }]
    })
  );

  return server;
}

export default createMcpHandler(createServer);
```

`createMcpHandler` creates a fresh server for every request. Its default `legacy: "stateless"` behavior provides 2025 wire compatibility without sessions, Durable Objects, storage, or a second tool definition.

## Run

```sh
npm install
npm run dev
```

Connect an MCP client or the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) to `http://localhost:8787/mcp`.

Use `createMcpHandler(createServer, { legacy: "reject" })` instead if the endpoint should accept only MCP `2026-07-28`.

For Agents-owned route matching, CORS, OAuth context bridging, and temporary SDK v1 application compatibility, see [`mcp-worker`](../mcp-worker/).
