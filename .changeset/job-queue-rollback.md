---
"agents": patch
---

The Lifecycle job queue recreates its table when a rolled-back transaction dropped it, instead of failing every later job write until the object restarts.
