---
"agents": patch
---

`AgentWorkflow`'s `this.agent`, the MCP RPC client transport and `getAgentByName`'s retries now open a new stub after the Agent was reset, instead of failing every later call through the broken one, and an RPC-connected `McpAgent` keeps the client's handshake across a restart.
