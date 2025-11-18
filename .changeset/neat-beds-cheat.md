---
"agents": patch
---

Allow `this.destroy` inside a schedule by including a `destroyed` flag and yielding `ctx.abort` instead of calling it directly
Fix issue where schedules would not be able to run for more 30 seconds due to `blockConccurencyWhile`. `alarm()` isn't manually called anymore, getting rid of the bCW.
Fix an issue where immediate schedules (e.g. `this.schedule(0, "foo"))`) would not get immediately scheduled.
