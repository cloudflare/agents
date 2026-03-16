# Migrating to `@cloudflare/codemode/mcp`

## Before

Wrapping an MCP server with codemode required ~150-200 lines of boilerplate: connecting as a client, listing tools, creating a new server, registering search/execute tools with hand-written descriptions, wiring up code execution.

## After

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { codeMcpServer } from "@cloudflare/codemode/mcp";

const upstream = new McpServer({ name: "my-tools", version: "1.0.0" });
upstream.registerTool("my_tool", { ... }, handler);

const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
const server = await codeMcpServer(upstream, executor);
```

The returned `server` has a single `code` tool. Each upstream tool becomes a typed method — the LLM writes `await codemode.myTool({ ... })` (or `myTools.myTool()` if the upstream server is named "my-tools").

## Migration steps

1. `npm install @cloudflare/codemode@latest`
2. Replace your manual server creation with `codeMcpServer(upstream, executor)`
3. Remove search/execute tool registration, search/code executors, truncation utils
4. Serve the returned server with `createMcpHandler` or any MCP transport

## Notes

- The upstream server must not be connected to a transport before calling `codeMcpServer()`.
- The SDK namespace is derived from the upstream server's name (sanitized).
- Auth is handled at the transport layer, not by `codeMcpServer`.
