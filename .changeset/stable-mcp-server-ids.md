---
"agents": patch
---

Support stable, caller-supplied server ids in `addMcpServer` for connector-style integrations.

Both the HTTP and RPC overloads of `addMcpServer` now accept an optional `id` field on their options object. When provided, this id replaces the generated `nanoid(8)` as the server's id in storage, restore, `listServers()`, `listTools()`, `getAITools()` (so tool keys become e.g. `tool_github_create_pull_request` instead of opaque connection ids), and OAuth state.

The supplied id is normalized via the exported `normalizeServerId` helper so that values like `"GitHub MCP!"` become `"github-mcp"` — guaranteeing the id is safe to embed in AI SDK tool names and storage keys.

**Fully additive — no user code breaks.** If you add `{ id: "github" }` to an existing `addMcpServer` call for a server that's already registered under an auto-generated nanoid, the SDK transparently migrates the existing storage row, in-memory connection, and OAuth-related DO storage keys to the new stable id. No `removeMcpServer` step required, no stale rows, no broken hibernation restore.

`addMcpServer` only throws on a genuinely ambiguous collision: the same stable id already belongs to a _different_ `(name, url)` server.

```ts
await this.addMcpServer("GitHub", env.MCP_SESSION, {
  id: "github",
  props: { token: "..." }
});
// tools surface as `tool_github_<name>`
```

Closes #1564.
