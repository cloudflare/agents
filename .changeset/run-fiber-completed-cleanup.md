---
"agents": patch
---

`runFiber()` no longer calls `onFiberRecovered()` for work that already finished (#2305). When the function settles but deleting its row fails, the fiber now marks the row finished, and the next recovery scan deletes it without calling the hook. A sub-agent keeps its root registration until that row is gone, so root housekeeping still comes back to clean it up.
