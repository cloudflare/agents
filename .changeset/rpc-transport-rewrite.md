---
"agents": minor
---

Add RPC transport for MCP: connect an Agent to an McpAgent via Durable Object bindings

**New feature: `addMcpServer` with DO binding**

Agents can now connect to McpAgent instances in the same Worker using RPC transport — no HTTP, no network overhead. Pass the Durable Object namespace directly:

```typescript
// In your Agent
await this.addMcpServer("counter", env.MY_MCP);

// With props
await this.addMcpServer("counter", env.MY_MCP, {
  props: { userId: "user-123", role: "admin" }
});
```

The `addMcpServer` method now accepts `string | DurableObjectNamespace` as the second parameter with proper TypeScript overloads, so HTTP and RPC paths are type-safe and cannot be mixed.

**Hibernation support**

RPC connections survive Durable Object hibernation automatically. The binding name and props are persisted to storage and restored on wake-up, matching the behavior of HTTP MCP connections. No need to manually re-establish connections in `onStart()`.

**Deduplication**

Calling `addMcpServer` with the same server name multiple times (e.g., across hibernation cycles) now returns the existing connection instead of creating duplicates. This applies to both RPC and HTTP connections. Connection IDs are stable across hibernation restore.

**Other changes**

- Rewrote `RPCClientTransport` to accept a `DurableObjectNamespace` and create the stub internally via `getServerByName` from partyserver, instead of requiring a pre-constructed stub
- Rewrote `RPCServerTransport` to drop session management (unnecessary for DO-scoped RPC) and use `JSONRPCMessageSchema` from the MCP SDK for validation instead of 170 lines of hand-written validation
- Removed `_resolveRpcBinding`, `_buildRpcTransportOptions`, `_buildHttpTransportOptions`, and `_connectToMcpServerInternal` from the Agent base class — RPC transport logic no longer leaks into `index.ts`
- Added `AddRpcMcpServerOptions` type (discriminated from `AddMcpServerOptions`) so `props` is only available when passing a binding
- Added `RPC_DO_PREFIX` constant used consistently across all RPC naming
- Fixed `MCPClientManager.callTool` passing `serverId` through to `conn.client.callTool` (it should be stripped before the call)
- Added `getRpcServersFromStorage()` and `saveRpcServerToStorage()` to `MCPClientManager` for hibernation persistence
- `restoreConnectionsFromStorage` now skips RPC servers (restored separately by the Agent class which has access to `env`)
- Reduced `rpc.ts` from 609 lines to 245 lines
- Reduced `types.ts` from 108 lines to 26 lines
- Updated `mcp-rpc-transport` example to use Workers AI (no API keys needed), Kumo/agents-ui components, and Tailwind CSS
- Updated MCP transports documentation
