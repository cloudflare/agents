---
"@cloudflare/think": patch
---

Aged-media eviction now runs for every sub-agent: sibling sub-agents that queued a pass at the same time no longer replace each other's pass.
