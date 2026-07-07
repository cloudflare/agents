---
"agents": minor
---

Add MCP SDK v2 support to `createMcpHandler`. Pass a factory returning `McpServer` or `Server` from the exact-pinned `@modelcontextprotocol/server@2.0.0-beta.2` peer dependency to serve MCP `2026-07-28` with stateless 2025 compatibility by default. The returned handler exposes the upstream `fetch`, `close`, `notify`, and `bus` controls. The retained v1 APIs use the exact-pinned `@modelcontextprotocol/sdk@1.29.0` peer dependency.

The stateless 2025 fallback continues to use Agents' `WorkerTransport`, including fail-fast handling for unsupported server-to-client requests. `createLegacyMcpHandler` is now an explicit public API for SDK v1 servers and complete WorkerTransport options. `WorkerTransport` and `createLegacyMcpHandler` are retained; only passing an SDK v1 server to the overloaded `createMcpHandler` is deprecated for removal in the next major release. `McpAgent` remains available as a deprecated, feature-frozen stateful SDK v1 path.

The v2 callable handler also maps verified provider-issued metadata from compatible `@cloudflare/workers-oauth-provider` releases to standard MCP `AuthInfo` while preserving `getMcpAuthContext().props`.
