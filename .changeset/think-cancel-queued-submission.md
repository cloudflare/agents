---
"@cloudflare/think": patch
---

Prevent cancelled durable submissions from appending their messages when they were already claimed but still waiting behind an active turn.
