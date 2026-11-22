---
"agents": patch
---

`tasks.run()` now throws when a reused `runId` or `idempotencyKey` comes with a different input, instead of silently returning the earlier run. The same data in another key order still joins.
