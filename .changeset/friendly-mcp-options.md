---
"agents": patch
---

feat: Add options-based API for `addMcpServer`

Adds a cleaner options-based overload for `addMcpServer()` that avoids passing `undefined` for unused positional parameters.

### Before (still works)

```typescript
// Awkward when you only need transport options
await this.addMcpServer("server", url, undefined, undefined, {
  transport: { headers: { Authorization: "Bearer ..." } }
});
```

### After (preferred)

```typescript
// Clean options object
await this.addMcpServer("server", url, {
  transport: { headers: { Authorization: "Bearer ..." } }
});

// With callback host
await this.addMcpServer("server", url, {
  callbackHost: "https://my-worker.workers.dev",
  transport: { type: "sse" }
});
```

### Options

```typescript
type AddMcpServerOptions = {
  callbackHost?: string; // OAuth callback host (auto-derived if omitted)
  agentsPrefix?: string; // Routing prefix (default: "agents")
  client?: ClientOptions; // MCP client options
  transport?: {
    headers?: HeadersInit; // Custom headers for auth
    type?: "sse" | "streamable-http" | "auto";
  };
};
```

The legacy 5-parameter signature remains fully supported for backward compatibility.
