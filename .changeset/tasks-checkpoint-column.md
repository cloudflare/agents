---
"agents": patch
---

Internal refactor, no API change: a Task run's checkpoint lives on its run row, so each chat turn writes one storage row less.
