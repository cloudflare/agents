---
"agents": minor
"@cloudflare/codemode": patch
---

Add MCP SDK v2 client and server support. `MCPClientConnection` now uses the exact-pinned `@modelcontextprotocol/client@2.0.0-beta.5`. It probes for stateless MCP with `server/discover`, then falls back to the legacy `initialize` handshake on the same connection when needed. The SDK auto-fulfills stateless elicitation `input_required` results through the existing form and URL elicitation handlers while `callTool`, `getPrompt`, and `readResource` remain pending. OAuth reauthorization discards redirect-scoped discovery after token issuance and preserves discovery-triggered authentication, allowing a changed authorization server to be rediscovered and registered without reusing the prior issuer's credentials. Legacy pushed elicitation, Streamable HTTP, SSE, RPC, OAuth, and hibernation recovery remain supported. Codemode's MCP connector now uses an SDK-neutral structural boundary compatible with both MCP client generations.

Add MCP SDK v2 support to `createMcpHandler`. Pass a factory returning `McpServer` or `Server` from the exact-pinned `@modelcontextprotocol/server@2.0.0-beta.5` peer dependency to serve stateless MCP with legacy compatibility by default. The new `agents/mcp/server` entry exports the stateless Agents handler without retaining `McpAgent`, `WorkerTransport`, MCP client transports, PartyServer, or SDK v1 modules. The returned handler remains callable for Worker dispatch and exposes the lower-level SDK `fetch(request, options?)` method plus typed `notify` methods; upstream `close` and event-bus internals are not part of the Agents surface. The retained v1 server APIs use the exact-pinned `@modelcontextprotocol/sdk@1.29.0` peer dependency.

The legacy compatibility fallback now uses SDK v2's web-standard transport, including fail-fast handling for unsupported server-to-client requests, active-request teardown, and the same 25-second Cloudflare SSE keepalive previously supplied by `WorkerTransport`. It returns `405` for session-only GET and DELETE requests without constructing an application server. `createLegacyMcpHandler` remains an explicit public API for SDK v1 servers and complete WorkerTransport options.

The MCP client storage codec now preserves stateless discovery data with resumed HTTP sessions and preserves the binding name and props required to restore RPC servers. Stored HTTP session IDs from older Agents versions have no associated protocol version. The upgraded client discards those IDs and reconnects instead of sending an unsafe resumed request, so in-flight work tied to an old remote session does not resume.

The v2 callable handler maps verified provider-issued metadata from compatible `@cloudflare/workers-oauth-provider` releases to standard MCP `AuthInfo` while preserving `getMcpAuthContext().props`.

The Workers handler rejects malformed, opaque, and non-HTTP browser Origins. Its default allowlist includes localhost-class Origins, the endpoint's `workers.dev` hostname, and a concrete `corsOptions.origin` hostname. It applies matching Host checks to localhost and `workers.dev` endpoints. Custom-domain deployments with wildcard CORS can set `allowedHostnames` and `allowedOriginHostnames` explicitly, or set `allowedOriginHostnames: "*"` when trusted upstream middleware already enforces the required Origin policy. Requests without Origin remain valid for non-browser MCP clients. Default CORS preflights allow the stateless `Mcp-Method` and `Mcp-Name` request headers.

`@cloudflare/codemode` is now an optional peer. Applications that import `agents/skills` or `agents/browser` install Codemode explicitly; MCP-only applications no longer install it transitively.

Deprecations in this release:

- `McpAgent` is deprecated and feature-frozen as a stateful SDK v1 path. New servers should use an SDK v2 factory with `createMcpHandler` from `agents/mcp/server`.
- Passing an SDK v1 server to the overloaded `createMcpHandler` is deprecated for removal in the next major release. Move the server to an SDK v2 factory. Use `createLegacyMcpHandler` only to temporarily retain sessionful SDK v1 behavior while migrating.
- The explicit result-schema overloads `MCPClientManager.callTool(params, resultSchema, options)` and `withX402Client(...).callTool(confirm, params, resultSchema, options)` are deprecated. Use `callTool(params, options)` or `callTool(confirm, params, options)` instead.

`experimental_createMcpHandler` was already deprecated and remains scheduled for removal in the next major release. Its warning now directs users to an SDK v2 factory first and names `createLegacyMcpHandler` only as a temporary bridge for sessionful SDK v1 behavior.
