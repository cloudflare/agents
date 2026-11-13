---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

Auto-continuation runs only for a tool result that settled its call, and only while that call's message is still the latest message, in both `AIChatAgent` and `Think`.
