---
"agents": minor
---

Add durable external events to `agents/tasks`.

`Tasks.sendEvent()` buffers run-scoped, optionally idempotent events. Task
definitions consume them FIFO by exact type with `step.waitForEvent()` or the
non-blocking `step.takeEvents()`. Event consumption and step journaling are
atomic, timed waits reuse Lifecycle's queue, and indefinite waits create no
alarm.
