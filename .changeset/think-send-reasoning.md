---
"@cloudflare/think": patch
---

Add `sendReasoning` controls to Think. Subclasses can set an instance-wide default, and `beforeTurn` can return a per-turn override to include or suppress reasoning chunks in UI message streams.
