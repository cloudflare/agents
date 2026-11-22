---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

A message sent while a turn runs is stored when its own turn starts, so each turn answers its own message and the transcript reads `U1, A1, U2, A2`. Tabs see it at once, drawn after the streaming reply. See [Message concurrency](https://github.com/cloudflare/agents/blob/main/docs/agents/chat-agents.md#messageconcurrency).
