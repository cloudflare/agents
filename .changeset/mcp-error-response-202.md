---
"agents": patch
---

`McpAgent` answers 202 to a POST that carries only a JSON-RPC error response instead of opening a stream that never ends, and `WorkerTransport` keeps a deleted session deleted after the Durable Object restarts.
