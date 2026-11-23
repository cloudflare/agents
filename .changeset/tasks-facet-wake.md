---
"agents": patch
---

A sub-agent's Task runs and their wakes live in its own storage, woken through its root. A sub-agent's `onAlarmMemoryLimit` now fires from its own alarm pass when one of its runs hits the memory limit.
