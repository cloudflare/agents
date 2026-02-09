---
"agents": minor
---

Add `createOAuthProvider` method to the `Agent` class, allowing subclasses to override the default OAuth provider used when connecting to MCP servers. This enables custom authentication strategies such as pre-registered client credentials or mTLS, beyond the built-in dynamic client registration.
