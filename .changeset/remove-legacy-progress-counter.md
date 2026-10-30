---
"agents": patch
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Fix the chat recovery progress marker growing by the object's whole stream history on every isolate restart, which could seal a healthy recovering turn with `work_budget_exceeded`; recovery also stops writing the old KV progress counter, and `agents/chat` drops the internal helpers only that counter needed. See [Recovery work units](https://github.com/cloudflare/agents/blob/main/docs/agents/chat-agents.md#recovery-work-units).
