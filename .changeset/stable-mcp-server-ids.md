---
"agents": minor
---

Support stable, caller-supplied server ids in `addMcpServer` for connector-style integrations.

Both the HTTP and RPC overloads of `addMcpServer` now accept an optional `id` field on their options object. When provided, this id replaces the generated `nanoid(8)` as the server's id in storage, restore, `listServers()`, `listTools()`, `getAITools()` (so tool keys become e.g. `tool_github_create_pull_request` instead of opaque connection ids), and OAuth state.

The supplied id is normalized via the exported `normalizeServerId` helper so that values like `"GitHub MCP!"` become `"github-mcp"` — guaranteeing the id is safe to embed in AI SDK tool names and storage keys. If a caller-supplied id already maps to a server with a different name or url, `addMcpServer` now throws instead of silently overwriting the existing row.

```ts
await this.addMcpServer("GitHub", env.MCP_SESSION, {
  id: "github",
  props: { token: "..." }
});
// tools surface as `tool_github_<name>`
```

Closes #1564.
