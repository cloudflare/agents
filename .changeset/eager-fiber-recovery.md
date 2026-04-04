---
"agents": patch
---

Run fiber recovery eagerly in `onStart()` instead of deferring to the next alarm. Interrupted fibers are now detected immediately on the first request after DO wake, with the alarm path as a fallback. A re-entrancy guard prevents double recovery.
