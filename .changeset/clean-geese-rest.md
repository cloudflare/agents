---
"agents": patch
---

Update the MCP dependencies to stable `@modelcontextprotocol/client@2.0.0` and `@modelcontextprotocol/server@2.0.0`, and update the retained SDK v1 compatibility dependency to `@modelcontextprotocol/sdk@1.30.0`. Delegate SDK-backed SSE keepalives to the upstream transports so each stream has one timer, while preserving the Agents-owned keepalive on the legacy McpAgent WebSocket bridge.
