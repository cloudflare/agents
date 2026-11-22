---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

`AIChatAgent` and `Think` send chat frames through one shared `ChatFrames` (origin message ids, queued messages, resume exclusion, recent terminals), with no change in behaviour.
