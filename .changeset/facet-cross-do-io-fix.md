---
"agents": patch
---

Fix `subAgent()` cross-DO I/O errors on first use.

Three issues in the facet initialization path caused `"Cannot perform I/O on behalf of a different Durable Object"` errors when spawning sub-agents in production:

- `subAgent()` constructed a `Request` in the parent DO and passed it to the child via `stub.fetch()`. The `Request` carried native I/O tied to the parent isolate, which the child rejected.
- The facet flag was set _after_ the first `onStart()` ran, so `broadcastMcpServers()` fired with `_isFacet === false` on the initial boot.
- `_broadcastProtocol()`, the inherited `broadcast()`, and `_workflow_broadcast()` iterated the connection registry without an `_isFacet` guard, letting broadcasts reach into the parent DO's WebSocket registry from a child isolate.

Replaces the fetch-based handshake with a new `_cf_initAsFacet(name)` RPC that runs entirely in the child isolate, sets `_isFacet` before init, and seeds partyserver's `__ps_name` key directly. Adds `_isFacet` guards to `_broadcastProtocol()` and overrides `broadcast()` to no-op on facets so downstream callers (chat-streaming paths, workflow broadcasts, user `this.broadcast(...)`) are covered. `_cf_markAsFacet()` is kept for back-compat and now marked `@deprecated`.
