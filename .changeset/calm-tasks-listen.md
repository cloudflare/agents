---
"agents": minor
---

Add durable external events to `agents/tasks`.

`Tasks.sendEvent()` buffers run-scoped, optionally idempotent events. Task
definitions consume them FIFO by exact type with `step.waitForEvent()` or the
non-blocking `step.takeEvents()`. Event consumption and step journaling are
atomic, timed waits reuse Lifecycle's queue, and indefinite waits create no
per-run wake job. Retrying a failed delivery with the same idempotency key
recovers a retained event that committed before wake synchronization failed.

Routed Task wakes now use a separate internal ID namespace so they cannot
collide with caller-selected local run IDs. Surviving legacy routed wake rows
migrate safely while local wake IDs and Task execution behavior remain
unchanged.
