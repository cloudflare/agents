---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

`AIChatAgent` and `Think` now run on one shared turn core, and `Think` stops a recovery the user cancels while it is already running.
