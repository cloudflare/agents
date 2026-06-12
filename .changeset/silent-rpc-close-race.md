---
"agents": patch
---

Ignore RPC responses when the WebSocket has already closed.

Async callable methods can finish after a client disconnects. The server now treats that closed-socket response delivery as a no-op instead of surfacing an uncaught `WebSocket send() after close()` error from the Workers runtime.
