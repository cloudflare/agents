---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

`AIChatAgent` and `Think` apply tool results and approvals the same way: a repeated result is a no-op in both, and a result reaches every stored copy of its call.
