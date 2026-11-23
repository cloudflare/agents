---
"agents": patch
"@cloudflare/think": patch
---

A sub-agent's schedules live in its own storage and are woken through its root. Think's scheduled tasks now run in a sub-agent, and `getSchedule()` and `getSchedules()` work there instead of throwing.
