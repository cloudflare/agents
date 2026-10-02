---
"agents": patch
---

Clients stop reconnecting after a sub-agent rejects a WebSocket, connection errors report every close that ends reconnection, and terminal rejections use close codes `4000 + status` (#2118). See [Sub-agents](https://github.com/cloudflare/agents/blob/main/docs/agents/sub-agents.md).
