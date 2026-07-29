---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Reduce SDK trace noise by consolidating initialization, chat setup, and fiber lifecycle spans around semantic agent operations.
