---
"agents": patch
---

Count job attempts durably before each run, so a job that exceeds the CPU or wall-time limit stops after its retry budget instead of running every 30 seconds forever, and keep other due jobs running when one fails with a transient platform error.
