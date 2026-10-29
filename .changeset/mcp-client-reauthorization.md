---
"agents": minor
---

MCP client: requests that need the user to authorize again throw `MCPAuthorizationRequiredError` with a link, failed servers stay `failed` until the new `reconnectMcpServer(id)`, and `@modelcontextprotocol/client` is now 2.4.0. See [MCP client](https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-client.md#failures-and-reconnecting).
