---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

A chat request waiting behind another turn is kept on its queued run instead of a separate admission record, and requests an earlier release left waiting are carried over.
