# Wrapping an MCP server with codemode

## Before

A normal MCP server exposes each tool individually. With 20+ tools, this floods the LLM's context and each tool call is a separate round trip.

```ts
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({ name: "my-tools", version: "1.0.0" });
server.registerTool(
  "add",
  { inputSchema: { a: z.number(), b: z.number() } },
  handler
);
server.registerTool("greet", { inputSchema: { name: z.string() } }, handler);
// ... 20 more tools

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(server)(request, env, ctx);
  }
};
```

## After

Wrap it with `codeMcpServer` — the LLM gets a single `code` tool with a typed SDK. It can discover tools, chain calls, and do logic in one shot.

```ts
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { codeMcpServer } from "@cloudflare/codemode/mcp";
import { z } from "zod";

const upstream = new McpServer({ name: "my-tools", version: "1.0.0" });
upstream.registerTool(
  "add",
  { inputSchema: { a: z.number(), b: z.number() } },
  handler
);
upstream.registerTool("greet", { inputSchema: { name: z.string() } }, handler);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const server = await codeMcpServer({ server: upstream, executor });
    return createMcpHandler(server)(request, env, ctx);
  }
};
```

The LLM now writes code like:

```js
async () => {
  const sum = await codemode.add({ a: 5, b: 3 });
  const greeting = await codemode.greet({
    name: "Result is " + sum.content[0].text
  });
  return greeting;
};
```

## Requirements

- `@cloudflare/codemode` with the `./mcp` export
- `@modelcontextprotocol/sdk` ^1.25.0 (peer dependency)
- `zod` ^3.25.0 or ^4.0.0 (peer dependency)
- A `WorkerLoader` binding (`worker_loaders` in wrangler.jsonc) for the `DynamicWorkerExecutor`

## Notes

- The upstream server must not be connected to a transport before calling `codeMcpServer()`.
- All upstream tools become typed methods on `codemode.*` in the sandbox.
- Auth is handled at the transport layer, not by `codeMcpServer`.
