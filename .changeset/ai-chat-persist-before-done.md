---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

AI Chat and Think send the terminal `done` frame after persisting and broadcasting the assistant reply, so later sends are not overwritten. See [Chat agents](https://github.com/cloudflare/agents/blob/main/docs/agents/chat-agents.md).
