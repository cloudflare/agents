---
"@cloudflare/think": patch
---

`approveExecution` and `rejectExecution` store the verdict before the approved call runs, so a reset during an approval finishes it on the next wake instead of losing it. Parked durable-pause actions move from `cf_think_action_pending_approvals` to the `Approvals` capability on the next start. The `action:pause:swept` event is now `approvals:swept`.
