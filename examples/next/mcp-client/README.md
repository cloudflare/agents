# Next: MCP client capability

A Vite + React demo that installs `MCPClientManager` into a plain Cloudflare
`DurableObject`. The UI accepts any Streamable HTTP MCP endpoint, completes
OAuth in a popup, and invokes discovered tools with JSON arguments.

```ts
export class McpClientObject extends DurableObject<Env> {
  readonly mcp = new MCPClientManager("mcp-client-object", "1.0.0");

  readonly lifecycle = Lifecycle.install(this).use(this.mcp);
}
```

The lifecycle initializes the manager's schema, restores persisted HTTP
connections after eviction, and offers registered OAuth callback URLs to the
manager before `onRequest()`.

## Run

```sh
pnpm install
pnpm run start
```

The React app creates a random object name on first load and keeps it in local
storage, giving each browser an isolated catalog and OAuth credentials. Its HTTP
API is:

```text
GET    /agents/mcp-client-object/:instance
POST   /agents/mcp-client-object/:instance/connect
POST   /agents/mcp-client-object/:instance/tools/call
DELETE /agents/mcp-client-object/:instance/servers/:id
```

The connect route derives `/callback` from the current request and registers
that exact URL. `routeAgentRequest()` forwards it to the same object; the
manager does not impose that route shape.

`getCatalog()` also demonstrates the native RPC boundary. RPC bypasses `fetch`,
so the method calls `await this.lifecycle.start()` before using the capability.
