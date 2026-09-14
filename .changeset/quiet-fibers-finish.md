---
"agents": patch
---

Preserve a legacy `runFiber` result when deleting its bookkeeping row fails. The cleanup error is logged and the row is left for the existing recovery pass instead of replacing the fiber body's outcome.
