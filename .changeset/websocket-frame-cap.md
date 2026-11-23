---
"agents": patch
---

An RPC result whose WebSocket reply is over 33,553,408 bytes (1 KiB under 32 MiB) now gets the "larger than the WebSocket message limit" error. Before, replies between 32 MiB less 73 bytes and 32 MiB were dropped, which left the call waiting and the connection silent; replies up to 951 bytes below that, which arrived before, now get the error too.
