---
"agents": patch
"@cloudflare/ai-chat": patch
---

Fix race condition where MCP tools are intermittently unavailable in onChatMessage after hibernation.

**`agents`**: Added `MCPClientManager.waitForConnections(options?)` which awaits all in-flight connection and discovery operations. Accepts an optional `{ timeout }` in milliseconds. Background restore promises from `restoreConnectionsFromStorage()` are now tracked so callers can wait for them to settle.

**`@cloudflare/ai-chat`**: Added `waitForMcpConnections` opt-in config on `AIChatAgent`. Set to `true` to wait indefinitely, or `{ timeout: 10_000 }` to cap the wait. Default is `false` (non-blocking, preserving existing behavior). For lower-level control, call `this.mcp.waitForConnections()` directly in your `onChatMessage`.
