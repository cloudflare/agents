---
"agents": patch
---

Fix WebSocket connections to sub-agents nested more than one level deep. A connection to `/sub/a/…/sub/b/…` failed during session setup with "Facet nesting depth limit exceeded": the internal header carrying the outer URL was forwarded to every child, so the second-level child resolved its connection from the top of the chain and routed back into the first level, recursively. The header now stops at the first hop, and no longer appears in `ctx.request.headers` inside sub-agent `onConnect` and `onBeforeSubAgent`.
