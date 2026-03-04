---
"agents": patch
---

Fix CHECK constraint migration for `cf_agents_schedules` table to include `'interval'` type, allowing `scheduleEvery()` and `keepAlive()` to work on DOs created with older SDK versions.
