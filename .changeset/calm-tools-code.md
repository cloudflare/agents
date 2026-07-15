---
"agents": patch
"@cloudflare/think": minor
"@cloudflare/codemode": patch
"@cloudflare/shell": patch
---

Make Think's built-in `code` a durable Code Mode runtime. Default turns keep `read`, `write`, `edit`, and `code` as the built-in model tools while exposing workspace, context, skills, extensions, configured fetch targets, and connected MCP servers as namespaced globals inside `code`. MCP connections no longer cause Think to materialize every MCP JSON Schema as a direct AI SDK tool.

Cache explicit `MCPClientManager.getAITools()` schema conversion per live connection until discovery replaces that connection's tool catalog.

The built-in `code` input is now `{ code: string }` rather than the legacy `{ script, cwd }` shell payload. `codeTool` is the new boolean opt-out. `workspaceBash = false` remains a deprecated compatibility alias. Configuration objects for the legacy `just-bash` snapshot tool should move to an explicitly created `createWorkspaceTools()` tool set.

Add a configurable namespace to `StateConnector`, which Think uses to expose the persistent filesystem as `workspace.*`.

Clarify Code Mode's generated instructions so a connector named `fetch` is not confused with the blocked bare `fetch(...)` global.
