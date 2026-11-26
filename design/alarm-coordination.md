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
  non-terminal run's authoritative `next_at` deadline is mirrored as one queue
  job per run. Task wakes use one job-dispatch attempt because ReplayStep owns
  their durable retry budget; a propagated platform failure must reach a fresh
  alarm invocation instead of entering JobDriver's generic retry loop.

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

Startup also runs a wake check: when the queue holds jobs and no alarm is set,
Lifecycle re-arms from the queue. An existing alarm is left alone. Without it,
a lost alarm strands every pending job until the next queue mutation, and an
alarm can be lost: the platform retries a throwing `alarm()` six times (at
about 2, 5, 9, 18, 36 and 78 seconds) and then drops it, and user code can
call `deleteAlarm()`. Measured on a deployed Worker, 22 Nov 2026.

A re-arm reads the current alarm first and writes only when the time changes,
and deletes only an alarm that is set. Each `setAlarm()` is billed as a row
written, and most queue mutations (a push later than the earliest job, a cancel
of a later job) leave the earliest wake where it was. Inside `alarm()` the
platform has already cleared the firing alarm, so `getAlarm()` reads the
latest alarm set since (the driver's startup fallback or deadman, or one a
queue mutation during the alarm set), and the end-of-alarm re-arm writes only
when that differs from the next wake.

## Facets

A facet (a sub-agent) has no alarm: `setAlarm` in a facet rejects, and one
that is not awaited breaks the facet instance (measured, 23 Nov 2026). A
facet's Lifecycle keeps its own `cf_agents_jobs` in its own storage and
drives it with the same driver as a root. Only arming differs:

- Where a root writes `setAlarm(T)`, a facet tells its root "wake path P at
  T". It does not sync first. An outgoing call from a Durable Object waits
  for its pending writes to be confirmed (its output gate), and if a reset
  still loses a row the root was told about, the root only drives the facet
  once for nothing. The report is skipped when the time has not changed since the last one.
- The root holds one job per facet path, id `facet:<path key>`, owned by
  the Lifecycle itself under an owner id per path. A facet that keeps
  failing therefore holds back only its own wake.
- When that job fires, the root calls down the path (at most three levels)
  and the facet runs its due jobs, its host `onAlarm` included. The reply
  carries the facet's next due time. The root's job moves there, or
  completes when the facet has nothing left. A path that no longer exists
  completes it too.
- The root waits on a facet's drive for at most five seconds. After that
  the call runs on by itself (tracked against the alarm's memory-limit
  breaker), the path gets a recheck wake 30 s out, and the facet's reply
  moves the wake when it comes. A drive request that arrives while one is
  still running is answered "busy" and rechecked later, so a facet never
  runs the same jobs twice at once.
- A facet job that takes the isolate down (a job over the memory limit
  resets the root with it, measured on a deployed tree) leaves no reply and nothing that could record a
  failure after the call. The root therefore counts each drive in its own
  storage, synced, before calling down, and clears the count on any reply.
  After three drives of a path that ended unreported, the path is not
  woken again for 30 s, doubling to an hour, however often the facet
  reports. Giving the facet's own job up after its attempts is the job
  driver's attempt count, inside the facet.
- A failure inside the facet is handled by the facet's driver (retries,
  holds, attempts, its own memory-limit breaker). When the call down fails
  (the facet cannot be reached or start, or was reset), the drive counts as
  unreported: the root keeps the path's wake and tries again after the
  recheck time or the back-off. The failure never reaches the root's own
  driver, so it cannot hold or purge the root's own jobs.
- Wake reports and drive replies carry a stamp that only goes up; the root
  ignores a message older than the one its wake holds, so a late drive
  reply cannot replace a newer report. A failed report is sent again,
  backing off from 100 ms to 30 s.
- The facet's deadman and startup fallback are the root's wake job, which
  stays until the reply re-arms it.
- On startup, a facet with jobs reports its next wake once, in case the
  root lost it.
- On startup, a root makes every facet wake due now (within its back-off).
  A root that starts may have been reset with its whole tree, and a facet's
  own start is what recovers its interrupted work (for example a turn whose
  claim would otherwise wait for its deadline), so each facet with jobs is
  woken once at once. That holds after one or two unreplied drives too:
  those are most often ordinary drives the reset cut off. A job that keeps
  ending the isolate is sealed by the facet's own count of unsettled
  attempts. Only a path past the back-off threshold waits.
- Deleting a facet sub-tree drops the wake jobs of that path and every path
  below it.

Fibers, KeepAlive, Queue, Scheduler (declared schedules too) and Tasks in a
facet use the facet's own job queue and contain no facet code. A queue item
a root still holds for a facet from an earlier release is handed to the
facet when it comes due: at once for most, at its retry time for one
waiting out a retry. A Task wake it still holds is made due at the root's
start and handed over then. A schedule it still holds is made due at the
root's next start, its own time kept, and handed over on that start's first
alarm; the facet takes it at its own time, and a copy the facet already made
of it since the upgrade is kept once, at the earlier time. All are dropped
if the facet is gone, or deleted with it. On its first start after the upgrade, a root's Fibers moves
any fiber wakes it mirrored for facets (old mirror jobs and the old
`cf_agents_facet_runs` index) onto facet wakes and drops them; a facet
starting after the upgrade arms its own fiber wake when it finds fibers
left behind.

A Task run that hits the memory limit in a facet is struck by the facet's
own breaker, and its policy (claim stripped, deadline pushed, seal) applies
in the facet, as at a root. A facet driven by its root with nothing due is
no clean pass, so an early drive (a root restart) does not clear those
strikes.

## When the alarm fires

`Lifecycle.alarm()` runs the event loop: arm the deadman, drive due jobs in
due order (single-flight skip/hung-recovery, per-job retry, platform-failure
deferral, `onJobError` for terminal application failures), run host
`onAlarm()`, clear the memory-limit strike counter when no handed-off work is
outstanding, and re-arm from queue state. A job that must keep working past
its bounded return registers that work with `trackAlarmWork`; the alarm still
returns promptly, so other jobs stay live, and the handoff is classified when
it settles. The loop stops if teardown disabled alarms mid-phase.

The alarm memory-limit circuit breaker (#1825) lives at this boundary. A
memory-limit reset is intercepted while every other error keeps platform alarm
retry semantics; a reset reported by handed-off work enters the same breaker
against the job that handed it off. One reset is one strike even when several
flows observe it (an in-alarm job plus handed-off work, or several handoffs
awaiting the same condemned storage): the counter moves once per event, each
observing job is backed off or purged, and the policy hooks run once per
observing job. Under the strike budget, the executing job and flagged
recovery-loop jobs move to a backoff wake. At the budget they are purged.
Lifecycle then supplies the executing-job identity to capability and host
policy hooks. Strikes clear only when an alarm ends, or the last outstanding
handoff settles, with no memory reset and nothing still running — a clean
sibling cannot hide a slower handoff's reset.

The strike counter is written after the reset, so it only advances while the
isolate's storage still accepts writes, for example when the reset error came
from another isolate such as D1. A Durable Object's own memory-limit reset
makes every later storage call in that invocation reject, and the counter
cannot move. Chat recovery therefore bounds its own crash loops: each attempt
records itself on the incident before doing heavy work, and the next attempt
counts any record another isolate left behind
([rfc-chat-recovery-interrupted-attempts.md](./rfc-chat-recovery-interrupted-attempts.md)).

Tasks uses that hook to update the struck run's authoritative row — claim
stripped, deadline pushed, state kept so the reclaim still sees an interrupted
attempt — preventing startup reconciliation from undoing queue backoff. At its
five-second job handoff it registers the still-running attempt with Lifecycle.
AI Chat and Think register the post-handoff model dispatch when the callback
runs under the alarm owner's dispatch — root Task runs and legacy root-owned
Scheduler rows. Chat recovery attempts run in chat-turn Task runs
(`__cf_internal_chat_turn`); the reserved `__cf_internal_chat_recovery`
definition only finishes runs an earlier version enqueued. A facet's chat recovery runs as a Task run in the facet, under
the facet's own alarm pass (driven by its root), so `trackAlarmWork` and the
breaker apply there as at a root.

## Agent integration

Agent installs Scheduler with policy options only, plus a composition-root
callback resolver for its historical name-based scheduling methods.
Keep-alive holds are the `KeepAlive` capability's single job. Deferred
teardown (#1625) is the internal `DeferredDestroy` capability
(`lifecycle/deferred-destroy.ts`): the durable destroy marker and one
exclusive wake job, re-armed from the marker on every start. Agent pushes no
host jobs. Fiber recovery is the `Fibers` capability's own
job (see [fibers.md](./fibers.md)). The host `getNextAlarm()`
contribution and Agent-owned breaker no longer exist.
