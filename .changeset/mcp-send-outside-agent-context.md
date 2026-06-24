---
"agents": patch
---

Allow `McpAgent` server-to-client requests to send from callbacks that do not inherit the agent's async context, including callbacks reached through Worker Loader RPC.
