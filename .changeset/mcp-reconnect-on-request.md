---
"agents": minor
---

MCP client: new `reconnectMcpServer(id)` retries a failed server; `addMcpServer()` reconnects a registered server that is not connected, except one stopped for a reason only a person can fix. See [Reconnecting on request](https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-client.md#reconnecting-on-request).
