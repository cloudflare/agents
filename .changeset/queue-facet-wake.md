---
"agents": patch
---

Internal refactor, no API change: a sub-agent's queue items live in its own queue and are woken through its root, and items the root held for a sub-agent move to it when they come due.
