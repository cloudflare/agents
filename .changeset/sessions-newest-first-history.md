---
"agents": patch
---

feat(sessions): `history({ newestFirst: true })` streams the active path leaf → root by following parent pointers, paying one row per message the consumer takes; compaction overlays are planned only once the walk reaches a compacted span. The change feed now reports `import` (one per row `importMessage()` actually writes) and `compaction` (an overlay stored through `addCompaction()`), so a host cache can tell when the path changed underneath it.
