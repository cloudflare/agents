---
"agents": patch
---

`@modelcontextprotocol/sdk` and `@modelcontextprotocol/server` are now optional peer dependencies, so apps that do not serve MCP no longer install the SDK v1 server stack (`express`, `cors`, `@hono/node-server`, and others). Install `@modelcontextprotocol/server` for `agents/mcp/server`, and `@modelcontextprotocol/sdk` for `McpAgent`, `WorkerTransport`, `createLegacyMcpHandler`, and `agents/experimental/webmcp`. The root `agents` entry and `agents/mcp/client` need neither. See [Creating MCP Servers](https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-servers.md#choosing-an-approach).
