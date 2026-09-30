---
"agents": patch
---

Lifecycle capabilities can push and cancel jobs synchronously with `jobs.pushSync()` and `jobs.cancelSync()`, so a job commits or rolls back with the capability's own writes in one `storage.transactionSync`. Call `jobs.rearm()` once the transaction commits.
