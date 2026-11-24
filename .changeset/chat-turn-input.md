---
"agents": patch
---

Internal refactor, no API change: a chat turn's run keeps its recovery snapshot in its input and writes only `stash()` data to its checkpoint.
