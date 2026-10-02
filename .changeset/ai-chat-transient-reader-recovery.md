---
"@cloudflare/ai-chat": patch
---

AI Chat recovers from transient response-reader errors instead of ending the turn, and respects recovery persistence choices without joining stale recovery runs. See [Chat agents](https://github.com/cloudflare/agents/blob/main/docs/agents/chat-agents.md).
