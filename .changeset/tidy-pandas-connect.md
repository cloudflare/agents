---
"hono-agents": patch
---

Preserve HTTP rejection responses returned by `onBeforeConnect` instead of continuing through downstream Hono handlers.

Existing applications that relied on rejected Agent WebSocket requests falling through to another Hono handler must mount `agentsMiddleware` on a narrower path or configure a distinct Agent route prefix. `hono-agents@3.0.12` also requires `agents >=0.17.1`.
