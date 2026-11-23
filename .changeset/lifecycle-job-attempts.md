---
"agents": patch
---

Count job attempts that end with their isolate, so a job that keeps exceeding the CPU or wall-time limit reaches `onJobError` after its retry budget instead of running every 30 seconds forever, and keep other due jobs running when one fails with a transient platform error.
