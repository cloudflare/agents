---
"agents": patch
---

fix(sub-agents): a facet sub-agent no longer touches the root DO's WebSockets, fixing a production-only "Cannot perform I/O on behalf of a different Durable Object (Native)" crash (#1677)

A sub-agent (facet) that called `setState()`, `broadcast()`, or otherwise enumerated connections — directly or indirectly via the internal `_broadcastProtocol()` — could crash in production with `Cannot perform I/O on behalf of a different Durable Object. ... (I/O type: Native)`. It reproduced when the **root** Agent held a live (hibernatable) WebSocket connection and the child facet was freshly bootstrapped; it never reproduced in `wrangler dev`/miniflare, which made it hard to catch.

Root cause: the `Agent` overrides of `getConnections()` and `getConnection()` fell through to `super.getConnections()` / `super.getConnection()` for facets too. On a facet, that resolves to the **host/root DO's** hibernatable WebSockets, and reading their attachments from the facet's I/O context is a cross-DO native I/O access that workerd aborts. `setState()` tripped it only incidentally, because `_broadcastProtocol()` enumerates connections to compute its exclude list before sending anything.

Fix: a facet's client connections are all virtual (real sockets owned by the root and bridged in), so `getConnections()`/`getConnection()` now return only the facet's virtual sub-agent connections and never fall through to the host DO's sockets. Delivery of facet state updates to clients connected directly to the sub-agent is unchanged.
