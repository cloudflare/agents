---
"agents": patch
---

`tasks.run()` now throws an error named `TaskInputConflictError` when a reused `runId` or `idempotencyKey` comes with a different input, instead of silently returning the earlier run. The same data in another key order still joins. See [Tasks](https://developers.cloudflare.com/agents/api-reference/tasks/).
