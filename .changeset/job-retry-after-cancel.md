---
"agents": patch
---

A schedule or queue item that is cancelled or replaced while its callback waits to retry no longer runs again with the old job. This also holds for sub-agent schedules and queue items, and when a second alarm invocation picks up the replacement.
