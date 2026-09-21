---
"agents": patch
---

`LifecycleJobs` gains `pushSync()` and `cancelSync()`: the same queue writes as `push()`/`cancel()` without the physical alarm re-arm, so a caller can write its job row inside its own `storage.transactionSync()` — where the async re-arm cannot be awaited — and have the job commit or roll back with the caller's own rows. The caller re-arms with `jobs.rearm()` once its transaction commits; a sync mutation made during startup needs no explicit call, because the re-arm is already deferred and coalesced to the end of startup. Nothing repairs a re-arm lost elsewhere, so an owner that pushes this way outside startup needs a startup reconcile of its own.

The job queue also repairs its cached "table exists" flag when a rolled-back caller transaction was the one that lazily created the table, so a read or write made inside such a transaction no longer breaks the queue for the rest of the isolate.
