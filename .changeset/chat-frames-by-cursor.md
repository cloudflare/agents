---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

A chat tab that reconnects gets every frame it missed, in order, including how every request that ran while it was away ended. Internal change to how `AIChatAgent` and `Think` send chat frames; no API change.
