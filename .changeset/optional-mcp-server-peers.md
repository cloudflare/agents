---
"agents": minor
---

`@modelcontextprotocol/sdk` and `@modelcontextprotocol/server` are now optional peer dependencies, so apps that do not serve MCP no longer install the SDK v1 server stack (`express`, `cors`, `@hono/node-server`, and others). Install `@modelcontextprotocol/server` for `agents/mcp/server`, and `@modelcontextprotocol/sdk` for `McpAgent`, `WorkerTransport`, `createLegacyMcpHandler`, and `agents/experimental/webmcp`. The root `agents` entry and `agents/mcp/client` need neither. If your app imports `@modelcontextprotocol/sdk` without listing it in `package.json`, add it before upgrading. The `agents/mcp` barrel needs `@modelcontextprotocol/sdk` even when you only import client helpers from it, so import those from `agents/mcp/client` instead. See [Creating MCP Servers](https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-servers.md#choosing-an-approach).
