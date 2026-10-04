---
"agents": patch
---

`MCPClientManager.removeServer()` (and `Agent.removeMcpServer()`) now clears the server's saved OAuth tokens, client information, discovery state and pending verifiers from Durable Object storage. Other servers' credentials are untouched. Tokens are not revoked at the OAuth provider.
