---
"@cloudflare/think": patch
---

Fix Think agents firing an alarm every 30s forever when they don't use workflow notifications (#1703).

`alarm()` called `_startWorkflowNotificationDrain()` unconditionally, which wrapped its work in `keepAliveWhile(...)`. Acquiring the keepAlive lease armed the 30s keepAlive heartbeat alarm even though there was nothing to drain, and releasing the lease did not pull the alarm back — so the DO re-scheduled itself every 30s and never hibernated.

`_startWorkflowNotificationDrain()` now returns early when there are no pending notifications, matching its other call sites. Affected DOs self-heal on their next alarm fire after upgrading: `super.alarm()` reschedules to the next legitimate task (or clears the alarm entirely) and the drain no longer re-arms the heartbeat.
