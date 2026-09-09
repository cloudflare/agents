---
"agents": patch
---

Compaction summaries now serialize structured tool outputs as JSON instead of `[object Object]`, matching how tool inputs were already rendered. Fixes #2138.
