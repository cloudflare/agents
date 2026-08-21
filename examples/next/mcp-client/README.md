# Next: MCP client capability

An early-access Vite + React demo that composes `MCPClientManager` into a plain
Cloudflare `DurableObject`. It does not extend `Agent` and does not forward
lifecycle hooks manually. The UI connects MCP servers and displays discovered
tools, prompts, resources, and connection state.

```ts
export class McpClientObject extends DurableObject<Env> {
  readonly mcp = new MCPClientManager("mcp-client-object", "1.0.0", {
    storage: this.ctx.storage
  });

  readonly lifecycle = Lifecycle.install(this).use(this.mcp);
}
```

`Lifecycle` automatically starts the manager before host work. The manager owns
its SQLite schema, restores persisted connections after eviction, and intercepts
registered OAuth callback URLs before `onRequest()`.

## Run

```sh
pnpm install
pnpm run start
```

Use the named object `demo`:

```sh
# Inspect the persisted MCP catalog.
curl http://localhost:8787/agents/mcp-client-object/demo

# Connect to a public MCP server.
curl -X POST \
  http://localhost:8787/agents/mcp-client-object/demo/connect \
  -H 'content-type: application/json' \
  -d '{"name":"docs","url":"https://docs.mcp.cloudflare.com/mcp"}'

# Remove the persisted server.
curl -X DELETE \
  http://localhost:8787/agents/mcp-client-object/demo/servers/docs
```

If a server requires OAuth, the response includes its authorization URL. The
example changes the current `/connect` URL suffix to `/callback`, registers that
exact URL with the manager, and handles it through the manager's lifecycle
request hook.

`routeAgentRequest()` routes
`/agents/mcp-client-object/demo/callback`, combining the standard `agents`
prefix, binding name, and object name. The manager itself does not require that
shape. You can use a custom prefix or a completely custom outer route as long
as that callback request is forwarded to the same named Durable Object.
Deriving the callback from the current request preserves that route choice.

The `getCatalog()` RPC method demonstrates the native RPC boundary: arbitrary
RPC bypasses `fetch`, so it explicitly calls `await this.lifecycle.start()`
before accessing the capability.
