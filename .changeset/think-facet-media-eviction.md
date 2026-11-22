---
"@cloudflare/think": patch
---

Aged-media eviction now runs for every sub-agent: sub-agents that queued a pass at the same time, including sub-agents of different classes with the same name, no longer replace each other's pass.
