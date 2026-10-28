---
"agents": minor
---

MCP client: `addMcpServer()` no longer reconnects a server that is already registered, so calling it from `onStart` or `onConnect` cannot undo a recorded failure or skip the reconnect backoff; new `reconnectMcpServer(id)` retries on request. Denied callbacks, rejected client registration and a `401` right after a completed authorization now stop instead of retrying or showing a dead link. See [Reconnecting on request](https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-client.md#reconnecting-on-request).
