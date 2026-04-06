---
"agents": patch
---

Fix MCP streamable HTTP client session lifecycle so closing connections explicitly terminates active sessions and persists session IDs across reconnects/restores.
