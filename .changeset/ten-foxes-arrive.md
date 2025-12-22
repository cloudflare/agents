---
"agents": patch
---

fix: scheduling should work

since we updated to zod v4, the schedule schema was broken. ai sdk's .jsonSchema function doesn't correctly work on tools created with zod v4. The fix, is to use the v3 version of zod for the schedule schema.
