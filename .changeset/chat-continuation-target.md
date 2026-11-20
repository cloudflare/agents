---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

Auto-continuation runs only for a tool result that settled its call, and only while that call's message is the last message, in both `AIChatAgent` and `Think`. A later message of any kind moves the conversation on, a message stored with `persistMessages` or a detached run's notification included: the tool result is stored and the next turn reads it.
