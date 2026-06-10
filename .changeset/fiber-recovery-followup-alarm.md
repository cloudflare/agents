---
"agents": patch
---

Fix runFiber recovery starving when a recovery scan leaves work behind. `_scheduleNextAlarm()` only armed a follow-up alarm for active keepAlive leases, due schedules, and facet runs — never for orphaned `cf_agents_runs` rows (or interrupted/pending managed ledger fibers) still awaiting recovery. Because orphaned fibers hold no keepAlive ref, a scan that yielded on `fiberRecoveryScanDeadlineMs` (or a pass that retained a repeatedly-throwing unmanaged hook for retry) would never get another alarm, so the remaining fibers were never recovered. The scheduler now arms a follow-up alarm whenever fiber recovery work is still outstanding, so multi-pass recovery resumes and eventually drains every fiber (and ages out poison rows via `fiberRecoveryMaxAgeMs`).
