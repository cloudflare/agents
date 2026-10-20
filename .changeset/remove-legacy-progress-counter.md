---
"agents": patch
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Chat recovery no longer reads or mirrors the KV progress counter that releases before 0.23 used, which removes a storage write per finished stream, and `agents/chat` drops the internal helpers only that counter needed. See [Recovery work units](https://github.com/cloudflare/agents/blob/main/docs/agents/chat-agents.md#recovery-work-units).
