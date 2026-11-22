---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

`AIChatAgent` and `Think` apply tool results and approvals through one shared `applyToolPartUpdate` in `agents/chat`. A repeated result is a no-op in both, and a result reaches every stored copy of its call.
