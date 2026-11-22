---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Internal refactor, no API change: `AIChatAgent` and `Think` send chat frames through the same code.
