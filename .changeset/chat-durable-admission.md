---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

A client request waiting behind a turn that an isolate reset cuts off now runs after the recovered turn, with its own reply, and pending Think submissions wait for that recovery too. See [Requests waiting behind an interrupted turn](https://developers.cloudflare.com/agents/api-reference/chat-agents/#requests-waiting-behind-an-interrupted-turn).
