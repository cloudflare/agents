---
"agents": patch
"@cloudflare/ai-chat": patch
---

Replace dynamic `import("ai")` with `z.fromJSONSchema()` from zod for MCP tool schema conversion, removing the `ai` runtime dependency from the agents core. Remove `ensureJsonSchema()` — no longer needed.
