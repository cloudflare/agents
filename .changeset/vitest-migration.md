---
"agents": minor
"@cloudflare/ai-chat": minor
"@cloudflare/think": minor
"@cloudflare/codemode": minor
---

Drop Zod v3 from peer dependency range — now requires `zod ^4.0.0`. Replace dynamic `import("ai")` with `z.fromJSONSchema()` from Zod 4 for MCP tool schema conversion, removing the `ai` runtime dependency from the agents core. Remove `ensureJsonSchema()`.
