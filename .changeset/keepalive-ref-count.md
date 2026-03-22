---
"agents": patch
---

Replace schedule-based keepAlive with lightweight ref-counted alarms

- `keepAlive()` no longer creates schedule rows or emits `schedule:create`/`schedule:execute`/`schedule:cancel` observability events — it uses an in-memory ref count and feeds directly into `_scheduleNextAlarm()`
- multiple concurrent `keepAlive()` callers now share a single alarm cycle instead of each creating their own interval schedule row
- add `_onAlarmHousekeeping()` hook (called on every alarm cycle) for extensions like the fiber mixin to run housekeeping without coupling to the scheduling system
- bump internal schema to v2 with a migration that cleans up orphaned `_cf_keepAliveHeartbeat` schedule rows from the previous implementation
- remove `@experimental` from `keepAlive()` and `keepAliveWhile()`
