---
"agents": patch
"@cloudflare/ai-chat": patch
---

Fix Stop cancelling overlapping active and pending turns, and prevent cancelled queued AI chat requests from starting. See [Chat agents](https://developers.cloudflare.com/agents/api-reference/ai-chat-agents/).
