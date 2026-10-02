---
"agents": patch
"@cloudflare/think": patch
---

`useAgentChat` keeps messages sent while disconnected when reconnecting, including Think transcripts, instead of erasing them (#1983). See [Chat agents](https://github.com/cloudflare/agents/blob/main/docs/agents/chat-agents.md).
