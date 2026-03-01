---
"agents": patch
---

Changed `addMcpServer` dedup logic to match on both server name AND URL for HTTP transport. Previously, calling `addMcpServer` with the same name but a different URL would silently return the stale connection. Now each unique (name, URL) pair is treated as a separate connection. RPC transport continues to dedup by name only.
