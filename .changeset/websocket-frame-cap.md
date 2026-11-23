---
"agents": patch
---

An RPC result whose WebSocket reply would be just under 32 MiB now gets the "larger than the WebSocket message limit" error instead of being dropped, which left the call waiting and the connection silent.
