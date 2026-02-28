---
"agents": patch
---

Remove redundant unawaited `updateProps` calls in MCP transport handlers that caused sporadic "Failed to pop isolated storage stack frame" errors in test environments. Props are already delivered through `getAgentByName` → `onStart`, making the extra calls unnecessary. Also removes the RPC experimental warning from `addMcpServer`.
