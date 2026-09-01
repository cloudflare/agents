# Alarm coordination

A Durable Object has one physical alarm timestamp. Lifecycle owns that
platform resource and derives it entirely from the state of the job queue it
also owns. See `lifecycle-work-queue.md` for the queue specification; this
document records the alarm-side model.

This replaces the earlier pull-based contribution model, in which each
capability implemented `getNextAlarm()` and `onAlarm()` and Scheduler was
"one alarm contributor, not the general alarm service". That decision was
deliberately reversed: Lifecycle is now the general work service, and
capabilities push jobs instead of contributing wake times.

## Domain model

- **Physical alarm** — the single timestamp stored by the Durable Object
  runtime. Only Lifecycle reads or writes it, always derived from queue
  state; queue mutations re-arm it automatically.
- **Job** — one durable row in the Lifecycle queue: a serialisable callback
  address (owning capability + fn), a due time, a payload, and queue policy.
- **Drive result** — what a job's owner returns after it runs: complete,
  `{ rescheduleAt }`, or `"yield"` (due again immediately).
- **Exclusive job** — suppresses ordinary alarm candidates while pending;
  used for wakes that must not be delayed by other work (deferred destroy).
- **Deadman pre-alarm** — armed before the event loop drives any due job, so
  an isolate death mid-drive still wakes the object to resume its queue.
- **Tasks** — the capability for durable replayable execution. Every
  non-terminal run's authoritative `next_at` deadline (acceptance, sleeps,
  retries, and claim backstops all write it) is mirrored as one queue job
  per run (`id = "task:" + the run id`, so a retime is a same-id push); the run's
  wake dispatches through `onJob` and settles or reschedules via the drive
  result.

## How the alarm is derived

The next physical alarm is a pure SQL computation over the queue:

1. If any exclusive job exists, the earliest exclusive time wins outright.
2. Otherwise the earliest ready job, clamped to the future (overdue rows
   survive restarts and must re-fire immediately), merged with the earliest
   hung-timeout recheck for in-flight single-flight jobs.
3. An empty queue deletes the physical alarm; the object hibernates.

Re-arm requests are serialized so a later durable-state change cannot be
overwritten by an earlier calculation, and requests made during startup are
coalesced and applied after startup completes.

## When the alarm fires

`Lifecycle.alarm()` runs the event loop: arm the deadman, drive due jobs in
due order (single-flight skip/hung-recovery, per-job retry, platform-failure
deferral, `onJobError` for terminal application failures), run host
`onAlarm()`, clear the memory-limit strike counter, re-arm from queue state.
The loop stops if teardown disabled alarms mid-phase.

The alarm memory-limit circuit breaker (#1825) lives at this boundary: a
memory-limit reset is intercepted (everything else re-throws so platform
alarm-retry semantics hold), a durable strike counter backs off the executing
job, and at the strike budget the executing job is purged and the host's
`onAlarmMemoryLimit()` hook applies domain policy (chat recovery sealing).

## Agent integration

Agent installs Scheduler with policy options only, plus a composition-root
callback resolver for its historical name-based scheduling methods.
Agent's own alarm work is pushed as host jobs — `cf:keep-alive`,
`cf:housekeeping`, and the exclusive `cf:destroy` derived from the durable
destroy marker — synchronized with durable state by `_syncHostJobs()` on
startup, on state changes, and after each alarm's housekeeping. Think adds
`think:workflow-notifications` the same way. The host `getNextAlarm()`
contribution and Agent-owned breaker no longer exist.
