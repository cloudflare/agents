---
"agents": patch
---

Fix two MCP client OAuth bugs found by the new conformance suite, and add MCP conformance testing.

- `MCPClientConnection` now finishes OAuth on the transport that received the 401. A fresh transport loses the resource metadata URL from the `WWW-Authenticate` header, so token exchange fell back to the default `/token` path and failed against authorization servers at non-default locations.
- `MCPClientConnection.init()` detaches the previous transport before reconnecting. Re-authorizing after a mid-session 401 (scope step-up, token revocation) previously failed permanently with "Already connected to a transport".
- Added the official `@modelcontextprotocol/conformance` suite (as used by the MCP TypeScript SDK) running against the MCP client (`Agent` + `MCPClientManager`), `McpAgent`, and `createMcpHandler` + `WorkerTransport` — all hosted in workerd via `wrangler dev`. See `packages/agents/conformance/README.md`.
