---
"agents": patch
---

Cache the active branch tip in `AgentSessionProvider` so finding the latest leaf no longer scans the whole session on every read and append.

`latestLeafRow()` previously ran an anti-join over every message row (O(rows)) to locate the branch tip — on each hydration AND each auto-parent append, so on long transcripts it dominated a wake's read cost. The tip is now maintained in place on append/delete/clear; a cached tip is re-validated on read with an O(1) existence + still-childless check (so it self-heals if another writer deletes the tip or gives it a child), and the full scan only runs when that check fails or the cache is cold. Per-hydration and per-append tip lookups drop from O(rows) to O(1), and the full scan never runs more often than before.
