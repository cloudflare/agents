---
"agents": patch
---

`MCPClientManager.registerServer()` now sends `transport.headers` on streamable-HTTP and SSE requests instead of silently dropping them.
