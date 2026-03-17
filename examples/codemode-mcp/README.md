# codemode-mcp

Demonstrates how to wrap any MCP server with `codeMcpServer` so an LLM gets a single `code` tool instead of a long list of individual tools.

## What this shows

A normal MCP server with N tools floods the LLM's context and requires a separate round-trip per tool call. `codeMcpServer` collapses the whole server into one `code` tool: every upstream tool becomes a typed method on `codemode.*`, and the LLM can chain calls, branch on results, and do logic — all in a single code execution.

This example exposes two endpoints:

- `/mcp` — the raw upstream server with three tools (`add`, `greet`, `list_items`)
- `/codemode` — the same server wrapped with `codeMcpServer`; one `code` tool, full typed SDK

## How to run

```bash
npm install
npm start
```

Connect an MCP client (e.g. Claude Desktop, MCP Inspector) to `http://localhost:8787/codemode`.

## Key pattern

```ts
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { codeMcpServer } from "@cloudflare/codemode/mcp";

const upstream = new McpServer({ name: "my-tools", version: "1.0.0" });
upstream.registerTool(
  "add",
  { inputSchema: { a: z.number(), b: z.number() } },
  handler
);

export default {
  async fetch(request, env, ctx) {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const server = await codeMcpServer({ server: upstream, executor });
    return createMcpHandler(server)(request, env, ctx);
  }
};
```

The LLM writes code like:

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

`wrangler.jsonc` needs a `worker_loaders` binding for the executor:

```jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

## Related

- [codemode-mcp-openapi](../codemode-mcp-openapi/) — same pattern but driven from an OpenAPI spec
- [`@cloudflare/codemode` docs](../../packages/codemode/README.md)
