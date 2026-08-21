---
"agents": patch
---

Fix nested sub-agent WebSocket routes recursing until the facet depth limit is exceeded. A route two or more hops deep (`/sub/{class}/{name}/sub/{class}/{name}`) upgraded with HTTP 101 and then closed with code `1011`, because the root's private route header was copied into every descendant's forwarded request — so a leaf read its own ancestor as one of its children and created facets recursively.

Descendants now route from their already-stripped connection URI. Deliveries back to the client are also awaited at each hop, so a reply or `broadcast()` from a leaf reaches the root-owned socket instead of being cut off with "RPC stub used after being disposed".
