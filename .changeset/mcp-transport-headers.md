---
"agents": patch
---

`MCPClientManager.registerServer()` now sends `transport.headers` on streamable-HTTP and SSE requests instead of silently dropping them, and persists `Headers` instances so they survive hibernation.
