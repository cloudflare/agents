---
"agents": patch
---

Export `DurableObjectOAuthClientProvider` from top-level `agents` package and fix `restoreConnectionsFromStorage()` to use the Agent's `createMcpOAuthProvider()` override instead of hardcoding the default provider
