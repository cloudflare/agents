---
"@cloudflare/codemode": patch
---

Unwrap MCP content wrappers in `codeMcpServer` so sandbox code sees plain values instead of raw `{ content: [{ type: "text", text }] }` objects. Error responses (`isError`) now throw proper exceptions catchable via try/catch, and `structuredContent` is returned directly when present.
