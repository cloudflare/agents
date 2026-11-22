---
"@cloudflare/think": patch
---

`approveExecution` and `rejectExecution` store the verdict before the approved call runs, so a reset during an approval finishes it on the next wake instead of losing it. Parked durable-pause actions move to a new table on the next start and stay approvable.
