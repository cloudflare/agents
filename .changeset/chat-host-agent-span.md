---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

`AIChatAgent` and `Think` call `Agent`'s span helper directly instead of each carrying a copy that reached a private method.
