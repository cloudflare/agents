---
"agents": minor
"@cloudflare/codemode": patch
---

Add MCP SDK v2 client and server support. `MCPClientConnection` now uses the exact-pinned `@modelcontextprotocol/client@2.0.0-beta.4`, negotiates modern or 2025-era servers automatically, and lets the SDK auto-fulfil modern `input_required` results through the existing form/URL elicitation handlers while `callTool`, `getPrompt`, and `readResource` remain pending. OAuth reauthorization now discards redirect-scoped discovery after token issuance and preserves discovery-triggered authentication, allowing a changed authorization server to be rediscovered and registered without reusing the prior issuer's credentials. Legacy pushed elicitation, Streamable HTTP/SSE/RPC transports, OAuth, hibernation recovery, and the deprecated v1-shaped manager overload remain supported. Codemode's MCP connector now uses an SDK-neutral structural boundary compatible with both MCP client generations.

Add MCP SDK v2 support to `createMcpHandler`. Pass a factory returning `McpServer` or `Server` from the exact-pinned `@modelcontextprotocol/server@2.0.0-beta.4` peer dependency to serve MCP `2026-07-28` with stateless 2025 compatibility by default. The returned handler exposes the upstream `fetch`, `close`, `notify`, and `bus` controls. The retained v1 server APIs use the exact-pinned `@modelcontextprotocol/sdk@1.29.0` peer dependency.

The stateless 2025 fallback continues to use Agents' `WorkerTransport`, including fail-fast handling for unsupported server-to-client requests. `createLegacyMcpHandler` is now an explicit public API for SDK v1 servers and complete WorkerTransport options. `WorkerTransport` and `createLegacyMcpHandler` are retained; only passing an SDK v1 server to the overloaded `createMcpHandler` is deprecated for removal in the next major release. `McpAgent` remains available as a deprecated, feature-frozen stateful SDK v1 path.

The v2 callable handler also maps verified provider-issued metadata from compatible `@cloudflare/workers-oauth-provider` releases to standard MCP `AuthInfo` while preserving `getMcpAuthContext().props`.
