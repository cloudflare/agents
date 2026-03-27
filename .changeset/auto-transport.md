---
"agents": patch
---

Add `transport: "auto"` option for `McpAgent.serve()` that serves both Streamable HTTP and legacy SSE on the same endpoint. Capable clients use Streamable HTTP automatically, while older SSE-only clients continue to work transparently.
