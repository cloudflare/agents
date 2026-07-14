---
"@cloudflare/think": minor
"@cloudflare/codemode": patch
"@cloudflare/shell": patch
---

Make Think's built-in `bash` a durable Code Mode runtime. Default turns keep `read`, `write`, `edit`, and `bash` as the built-in model tools while exposing workspace, context, skills, extensions, configured fetch targets, and connected MCP servers as namespaced globals inside `bash`. MCP connections no longer cause Think to materialize every MCP JSON Schema as a direct AI SDK tool.

The built-in `bash` input is now `{ code: string }` rather than the legacy `{ script, cwd }` shell payload. `workspaceBash` is now a boolean opt-out. Configuration objects for the legacy `just-bash` snapshot tool should move to an explicitly created `createWorkspaceTools()` tool set.

Add a configurable namespace to `StateConnector`, which Think uses to expose the persistent filesystem as `workspace.*`.

Clarify Code Mode's generated instructions so a connector named `fetch` is not confused with the blocked bare `fetch(...)` global.
