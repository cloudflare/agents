---
"agents": patch
---

MCP client: connection work for one server (connect, discovery, OAuth callback, restore) now runs one operation at a time, work that outlives `removeServer()` no longer writes back, and RPC servers restore in the background instead of holding startup. See [Waiting for Connections](https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-client.md#waiting-for-connections).
