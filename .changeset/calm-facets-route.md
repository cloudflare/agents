---
"agents": patch
---

Add `buildAgentPath()` and `buildAgentUrl()` for constructing canonical root-first Agent and sub-agent addresses for external HTTP requests, WebSocket connections, callbacks, and webhooks. React sub-agent connections now share the same descendant path encoder.
