# MCP Migration Guide

This guide covers breaking changes in the MCP server refactor.

## Summary

McpAgent now uses the MCP SDK's `WebStandardStreamableHTTPServerTransport` directly instead of a custom transport layer. The WebSocket bridging between Worker and Durable Object has been removed. McpAgent handles HTTP requests directly in the DO.

## Breaking Changes

### 1. Legacy SSE transport removed

`McpAgent.serveSSE()` and `McpAgent.mount()` have been removed. Only Streamable HTTP transport is supported via `McpAgent.serve()`.

**Before:**
```ts
MyMCP.serveSSE("/sse", { binding: "MyMCP" })
MyMCP.mount("/sse", { binding: "MyMCP" })
```

**After:**
```ts
MyMCP.serve("/mcp", { binding: "MyMCP" })
```

### 2. `WorkerTransport` removed

The custom `WorkerTransport` class has been removed. For low-level stateless MCP servers, use `createMcpHandler` (which now uses the SDK's `WebStandardStreamableHTTPServerTransport` under the hood) or use the SDK transport directly.

**Before:**
```ts
import { WorkerTransport } from "agents/mcp";
```

**After:**
```ts
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
```

### 3. `createMcpHandler` options simplified

The handler no longer accepts transport-specific passthrough options. It creates a stateless transport per request.

**Removed options:** `sessionIdGenerator`, `enableJsonResponse`, `onsessioninitialized`, `storage`, `transport`

**Kept options:** `route`, `corsOptions`, `authContext`

For stateful MCP servers with session management, use `McpAgent`.

### 4. Internal transport classes removed

The following internal classes are no longer exported:
- `McpSSETransport`
- `StreamableHTTPServerTransport` (the custom DO-based one)
- `WorkerTransport`
- `TransportState`, `MCPStorageApi`

### 5. Internal headers removed

`MCP_HTTP_METHOD_HEADER` (`cf-mcp-method`) and `MCP_MESSAGE_HEADER` (`cf-mcp-message`) are no longer used. The DO now handles HTTP directly without WebSocket bridging.

### 6. `createMcpHandler` requires a factory function

`createMcpHandler` now requires a factory function `() => McpServer | Server` instead of a direct server instance. The factory is called per request in stateless mode, ensuring clean server state for each request.

**Before:**
```ts
const server = new McpServer({ name: "My Server", version: "1.0.0" });
server.registerTool("add", { ... }, async () => { ... });
export default { fetch: createMcpHandler(server) };
```

**After:**
```ts
function createServer() {
  const server = new McpServer({ name: "My Server", version: "1.0.0" });
  server.registerTool("add", { ... }, async () => { ... });
  return server;
}
export default { fetch: createMcpHandler(createServer) };
```

### 7. Session routing changes

Session management is now handled entirely by the MCP SDK transport inside each Durable Object. The Worker-level routing in `McpAgent.serve()` uses the `mcp-session-id` header to route requests to the correct DO instance. Session validation (accept header checks, content-type validation, JSON-RPC parsing) happens inside the DO, not in the Worker.

This means:
- An initialization request with a session ID will route to that DO and succeed (the DO is the session)
- A non-init request to an uninitialized DO will return a 400 error from the SDK transport
- Session IDs are DO instance names (not random transport-generated IDs)

### 8. `McpAgent.serve()` options moved

`McpAgentServeOptions` replaces the old `ServeOptions` type:

**Removed options:** `prefix`, `onError`, `onSessionCreated`

**Kept options:** `binding` (default `"MCP_OBJECT"`), `corsOptions`, `jurisdiction`

## Architecture Overview

```
Worker (McpAgent.serve())
  └── Routes by mcp-session-id header → Durable Object
        └── McpAgent (DO)
              ├── onStart() — register tools, resources, prompts
              ├── _setupMcp() — create SDK transport, connect server
              └── onRequest() → transport.handleRequest(request)
                    └── WebStandardStreamableHTTPServerTransport (from SDK)
```

No WebSocket bridging. The DO handles HTTP requests directly and returns responses. State persists across DO hibernation via storage-backed initialize replay.

## Security: CVE-2026-25536

This refactor addresses [CVE-2026-25536](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-345p-7cg4-v4c7), a cross-client data leak in the MCP TypeScript SDK (versions 1.10.0–1.25.3) caused by reusing server or transport instances across clients.

**How our APIs prevent this:**

- **`McpAgent`** — each client session maps to its own Durable Object with its own server and transport instance. One client per DO, no sharing possible.
- **`createMcpHandler`** — requires a factory function (not a server instance). A fresh server and transport are created per request. It is impossible to accidentally reuse a server across requests.

If you are using the MCP SDK's `WebStandardStreamableHTTPServerTransport` directly (outside of our APIs), you must create a new server and transport per request/session. Never reuse either across clients.
