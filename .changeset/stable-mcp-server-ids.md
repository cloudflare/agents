---
"agents": minor
---

Support stable, caller-supplied server ids in `addMcpServer` for connector-style integrations.

Both the HTTP and RPC overloads of `addMcpServer` now accept an optional `id` field on their options object. When provided, this id replaces the generated `nanoid(8)` as the server's id in storage, restore, `listServers()`, `listTools()`, `getAITools()` (so tool keys become e.g. `tool_github_create_pull_request` instead of opaque connection ids), and OAuth state.

The supplied id is normalized via the exported `normalizeServerId` helper so that values like `"GitHub MCP!"` become `"github-mcp"` — guaranteeing the id is safe to embed in AI SDK tool names and storage keys.

`addMcpServer` now throws explicitly when a stable id would conflict with existing storage:

- the supplied id already belongs to a different `(name, url)` server, or
- the same `(name, url)` is already registered under a different id (e.g. an auto-generated nanoid from a previous call). The error message points the caller at `removeMcpServer(oldId)` to migrate. This avoids silently returning the old id or leaving a stale storage row after `INSERT OR REPLACE`.

```ts
await this.addMcpServer("GitHub", env.MCP_SESSION, {
  id: "github",
  props: { token: "..." }
});
// tools surface as `tool_github_<name>`
```

Closes #1564.
