---
"agents": patch
---

`deleteSubAgent` now closes the sub-agent's direct client connections, so late messages can't recreate it (#2003). See [Sub-agents](https://github.com/cloudflare/agents/blob/main/docs/agents/sub-agents.md).
