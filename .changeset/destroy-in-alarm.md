---
"agents": patch
---

An agent that calls `destroy()` from a scheduled callback stays destroyed, instead of being constructed again about 30 seconds later.
