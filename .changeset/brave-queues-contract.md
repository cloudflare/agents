---
"agents": patch
---

Define the Lifecycle job dispatch contract. Job ids are now scoped to their
owning capability: a cross-owner id collision throws instead of silently
replacing the other owner's job. A same-id `push()` or `reschedule()` made
while a job is dispatching supersedes the returned drive result, so a wake
pushed mid-drive can no longer be lost. A dispatch that outlives its job's
hung timeout logs a warning and emits `job:slow_dispatch` telemetry —
`onJob` must stay bounded and detach unbounded work.
