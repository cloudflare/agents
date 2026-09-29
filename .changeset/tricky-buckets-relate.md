---
"agents": patch
---

Fix `deleteSubAgent` not sticking while a client is still connected directly to the sub-agent (#2003). A `message` or `close` event on that WebSocket used to be forwarded through the same create-on-access resolver used for new connections, silently recreating the deleted sub-agent (and its registry row). `deleteSubAgent` (and a sub-agent's own `destroy()`) now close any matching client connection (code `1001`, reason `"Sub-agent deleted"`) before tearing the facet down. Late events from those sockets are dropped, so they can't recreate the child or reach a same-name replacement, and `message`/`close` forwarding never creates a sub-agent.
