---
"agents": patch
---

Fix `deleteSubAgent` not sticking while a client is still connected directly to the sub-agent. A `message` or `close` event on that WebSocket used to be forwarded through the same create-on-access resolver used for new connections, silently recreating the deleted sub-agent (and its registry row). `deleteSubAgent` now also closes any matching client connection (code `1001`, reason `"Sub-agent deleted"`) before tearing the facet down, and WebSocket `message`/`close` forwarding now resolves only against a sub-agent that still has a live registry row instead of creating one.
