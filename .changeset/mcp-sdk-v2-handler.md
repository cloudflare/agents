---
"agents": minor
---

Add MCP SDK v2 support to `createMcpHandler`. Import `McpServer` or `Server` from `@modelcontextprotocol/server` to serve MCP `2026-07-28` with stateless 2025 compatibility by default; factories provide request isolation and the returned handler exposes the upstream `fetch`, `close`, `notify`, and `bus` controls.

Existing MCP SDK v1 server inputs continue using the complete `WorkerTransport` handler behavior and now emit a once-per-isolate migration warning. `WorkerTransport` and its option/storage types are deprecated for removal in the next major release. `McpAgent` remains available as a deprecated, feature-frozen stateful SDK v1 path.

The v2 callable handler also maps verified provider-issued metadata from compatible `@cloudflare/workers-oauth-provider` releases to standard MCP `AuthInfo` while preserving `getMcpAuthContext().props`.
