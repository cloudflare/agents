---
"agents": patch
---

Reuse retained sub-agent connection bridges for broadcasts that continue after a WebSocket handler returns, avoiding root Agent resolution and Durable Object RPC requests for every streamed chunk.
