---
"agents": patch
---

`McpAgent` no longer leaves a Durable Object behind for a streamable HTTP request with an unknown session ID, and checks the session in the same call that accepts the request, which also saves a round trip per request.
