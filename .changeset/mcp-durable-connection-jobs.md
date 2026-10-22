---
"agents": patch
---

MCP client: failed connections now reconnect in the background on a durable backoff (30s up to every 30m, giving up after 24h), authorization links that expire unused mark the server `failed` instead of lingering, and `addMcpServer()` reconnects a failed server instead of throwing. See [Automatic reconnects](https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-client.md#automatic-reconnects).
