---
"agents": patch
---

`agents/streams`: `list()` now breaks `created_at` ties by insertion order, `close({ commit })` throws and rolls back if `commit` returns a promise, and `read`/`readBatches` throw `RangeError` for a non-integer `from` or non-finite `batchSize`. See [#2853](https://github.com/cloudflare/agents/issues/2853).
