---
"agents": patch
---

Sub-agents no longer sync root-owned host jobs. A facet has no alarm slot, so `_syncHostJobs()` on a facet only opened a `schedule_agent_alarm` span on every wake, and when a facet's startup fiber recovery left a row behind (for example a throwing `onFiberRecovered`), it pushed a housekeeping job whose `setAlarm()` threw and failed the facet's first call after every restart. The root's facet-run lease already drives that retry. A host job an earlier release left in a facet's queue is dropped on the next wake.
