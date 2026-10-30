---
"agents": minor
---

MCP client: requests that need the user to authorize again throw `MCPAuthorizationRequiredError` with a link, and failed servers stay `failed` until the new `reconnectMcpServer(id)`. See [MCP client](https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-client.md#failures-and-reconnecting).
