---
"agents": patch
---

An MCP server removed and added again under the same id while it was still connecting now starts clean. The removed server's connect no longer marks the new one failed ("was removed while connecting"), and its retries no longer connect the new one a second time. With a custom `createAuthProvider`, `removeMcpServer()` no longer deletes the stored row of a server added again while it cleared credentials.
