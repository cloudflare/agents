---
"agents": patch
---

Allow sub-agents to use alarm-backed APIs by delegating the physical Durable Object alarm to the top-level parent while executing logical work inside the owning sub-agent. This enables `schedule()`, `scheduleEvery()`, `cancelSchedule()`, `getScheduleById()`, `listSchedules()`, `keepAlive()`, `keepAliveWhile()`, `runFiber()`, and Think chat recovery inside sub-agents.

Sub-agent schedules are scoped to the calling child, so sibling sub-agents cannot cancel each other's schedules by id. The deprecated synchronous `getSchedule()` and `getSchedules()` APIs now throw inside sub-agents; use the async alternatives instead. Destroying a sub-agent now delegates cleanup through the parent so parent-owned schedules and descendant fiber recovery leases are removed consistently.
