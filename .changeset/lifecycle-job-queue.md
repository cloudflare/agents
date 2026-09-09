---
"agents": minor
"@cloudflare/think": minor
---

Lifecycle owns a durable job queue, driven as an alarm event loop.

The thing in the queue is a job: a serialisable callback address — the
owning capability plus a function name — with a due time and a payload.
Capabilities and the host push jobs through the scoped `jobs` surface;
Lifecycle drives due jobs in timestamp order when the alarm fires, owns
dispatch retries and platform-failure deferral, arms a deadman pre-alarm
before driving so an isolate death mid-drive still wakes the object, and
derives the physical alarm purely from queue state (queue mutations re-arm
automatically; an exclusive job suppresses ordinary candidates).

```ts
class Cleanup extends LifecycleCapability {
  async scheduleSweep(time: number) {
    await this.lifecycle.jobs.push({ id: "sweep", fn: "sweep", time });
  }
  onJob({ job }: LifecycleJobContext) {
    // drive result: nothing = complete, { rescheduleAt } = suspend,
    // "yield" = leave due and wake again immediately
  }
}
```

The pull-based alarm-contribution model is removed: capability
`getNextAlarm()`/`onAlarm()`, host `getNextAlarm()`,
`LifecycleServices.alarms` (`rearm`/`disabled`), and `AlarmContribution`
are gone. Host `onAlarm()` remains and runs once per alarm invocation
after due jobs are driven. Terminal application failures reach the
owner's `onJobError()`, whose drive result decides advancement.

The alarm memory-limit circuit breaker (#1825) moves from `Agent.alarm()`
into the Lifecycle event loop, targeting the exact executing job; Agent
contributes domain policy through the new `onAlarmMemoryLimit()` host
hook, and Scheduler's `__DO_NOT_USE_WILL_BREAK__handleAlarmMemoryLimit`
escape hatch is gone. After recording a strike the breaker now finishes by
resetting the isolate with `ctx.abort(reason, { retryAlarm: false })`
(retry of the handled alarm suppressed; the backoff alarm owns the next
wake), and `Agent.destroy()` uses the same no-retry abort so a completed
teardown's alarm cannot be retried into a fresh constructor that recreates
the deleted schema.

Scheduler keeps its entire public API and loses its storage and due-row
loop: a schedule is one job whose `fn` is the callback name, and interval
schedules are single-flight jobs. Existing `cf_agents_schedules` rows are
migrated into the `cf_agents_jobs` queue on startup and the legacy table
is dropped. Agent's public scheduling and `keepAlive()` APIs are
unchanged; its keep-alive, fiber-recovery/facet housekeeping, and
deferred-destroy wakes are now host jobs, and Think's
workflow-notification wake replaces the removed `_getExtensionAlarm()`.
