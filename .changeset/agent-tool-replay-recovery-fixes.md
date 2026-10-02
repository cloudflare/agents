---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Fix agent-tool chunks being duplicated or dropped on reconnect, child re-attach, and fiber recovery. See [Agent tools](https://github.com/cloudflare/agents/blob/main/docs/agents/agent-tools.md).
