---
"agents": patch
---

Fix `keepAlive()` leaving a stale 30s heartbeat alarm after the lease is released. Previously the dispose returned by `keepAlive()` (and used by `keepAliveWhile()`) only decremented the in-memory ref count and never rescheduled the alarm, so a short-lived lease could permanently bump the next alarm to `now + keepAliveIntervalMs` with nothing to pull it back. The dispose now recomputes the alarm from persistent state when the last lease is released (mirroring the facet release path), clearing the heartbeat when no other work needs it. Fixes #1704 (root cause behind #1703).
