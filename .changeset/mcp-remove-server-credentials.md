---
"agents": patch
---

`MCPClientManager.removeServer()` (and `Agent.removeMcpServer()`) now clears the server's saved OAuth state from Durable Object storage: tokens and client information (including those under earlier client IDs), verifiers, pending states and discovery state. This also works when the server's connection was already closed. Other servers' credentials are untouched, and tokens are not revoked at the OAuth provider. Custom auth providers get `invalidateCredentials("all")`.
