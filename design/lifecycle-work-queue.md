# Lifecycle job queue

Lifecycle owns the Durable Object's queue of durable work, not just its
physical alarm timestamp. The thing in the queue is a **job**: a serialisable
callback address — the owning capability plus a function name (`fn`) — with a
due time (epoch milliseconds) and a payload. Capabilities and the host push
jobs; Lifecycle runs the alarm as an event loop that drives due jobs in
timestamp order, applies retry policy, and re-arms the physical alarm from
queue state.

This replaced the pull-based alarm-contribution model (`getNextAlarm()` +
capability `onAlarm()`), which was removed outright rather than kept
alongside. `alarm-coordination.md` records the alarm-side model.

## Storage

Lifecycle owns one timestamp-ordered table, created lazily on first use:

```sql
CREATE TABLE IF NOT EXISTS cf_agents_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  capability TEXT NOT NULL,           -- owning capability id, or 'host'
  fn TEXT NOT NULL,                   -- serialisable function name
  time INTEGER NOT NULL,              -- epoch milliseconds
  payload TEXT,                       -- JSON, opaque to Lifecycle
  retry_options TEXT,                 -- JSON RetryOptions
  singleflight INTEGER NOT NULL DEFAULT 0,
  hung_timeout_seconds INTEGER,       -- single-flight hang cutoff (default 30)
  exclusive INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 0,
  execution_started_at INTEGER,       -- epoch milliseconds
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)
```

`cf_agents_schedules` is migrated into this table by Scheduler on startup
(rows become jobs with `capability = 'scheduler'`, `fn` = the callback name;
times convert from seconds to milliseconds; keep-alive heartbeat orphans are
dropped) and the legacy table is then dropped.

There are no lanes today. A lane, if it arrives, is just a named queue —
the `capability` column already partitions the table into one lane per
owner, and a finer queue-name field can subdivide later without schema
upheaval.

## Capability surface

`LifecycleServices.alarms` (`rearm()` / `disabled()`) is gone. In its place
every capability receives `jobs`, scoped to its capability id; the host uses
the same surface through `lifecycle.jobs`:

```ts
type LifecycleJobs = {
  push(options: {
    fn: string; // serialisable callback name
    time: number; // epoch ms
    payload?: unknown;
    id?: string; // provided id upserts (replace)
    retry?: RetryOptions;
    singleflight?: boolean; // skip while a prior run is in flight
    hungTimeoutSeconds?: number; // single-flight hang cutoff
    exclusive?: boolean; // suppress ordinary alarm candidates
  }): Promise<LifecycleJob>;
  cancel(id: string): Promise<boolean>;
  reschedule(id: string, time: number): Promise<boolean>;
  get(id: string): LifecycleJob | undefined; // sync SQL read
  list(): LifecycleJob[]; // sync SQL read
  rearm(): Promise<void>; // recover a lost alarm for existing jobs
};

// Available on Lifecycle and every capability's LifecycleServices:
trackAlarmWork(work: Promise<unknown>): boolean; // current alarm only
```

Every queue mutation re-arms the physical alarm automatically (deferred and
coalesced during startup). Hooks replace `onAlarm`/`getNextAlarm`:

```ts
onJob?(context: { job: LifecycleJob; attempt: number }):
  MaybePromise<LifecycleJobOutcome | void>;
onJobError?(context, error): MaybePromise<LifecycleJobOutcome | void>;

type LifecycleJobOutcome =
  | undefined                 // completed: delete the job
  | { rescheduleAt: number }  // suspended: wake at that time (epoch ms)
  | "yield";                  // yielded: leave due, wake again immediately
```

The host implements `onJob` for host-owned jobs (dispatched inside the
host invocation boundary; there is no host `onJobError` — a host job's
terminal failure completes it, and the host re-derives its jobs from
durable state); capability jobs dispatch outside ambient host context. Host `onAlarm()` survives: it runs once per alarm invocation after
due jobs are driven. Host `getNextAlarm()` is removed.

## The dispatch contract

Four named rules define what a job owner can and cannot rely on:

1. **Job ids are scoped to their owner.** Every queue verb — push
   included — sees only the owner's own jobs. A same-id push replaces the
   owner's job; a push whose id belongs to another owner throws instead
   of clobbering. (Tasks additionally prefixes its wake jobs `task:` so
   caller-selected run ids stay inside its own namespace.)
2. **Dispatch must be bounded.** The event loop drives due jobs inline
   and in order, so one long `onJob` delays every other job on the
   object — this is the queue's biggest behavioral bet, learned the hard
   way in the chat replatform. Detach unbounded work (start it, persist
   durable evidence, return) rather than awaiting it in the hook. The
   driver cannot safely abandon owner code, so the rule is enforced by
   visibility: a dispatch that outlives the job's `hungTimeoutSeconds`
   (default 30s) logs a warning and emits `job:slow_dispatch`. Work that must
   continue after a bounded handoff registers its promise with
   `trackAlarmWork()` so it remains part of the current alarm's breaker domain.
3. **Newer pushes win over drive results.** Every dispatched job carries
   a durable in-flight marker; a same-id `push()` or `reschedule()` made
   while the job executes clears it, and `applyOutcome` only applies a
   drive result to a still-marked job. The drive loop also refetches each
   due job before claiming it, so a job replaced earlier in the same
   alarm cycle dispatches with fresh data — or, if no longer due, is
   skipped. An owner can therefore never lose a wake it explicitly
   pushed mid-drive. Owners that both push and return outcomes for the
   same job (Tasks) should derive both from the same durable state so
   they always agree.
4. **Platform failures abort the drive loop.** A platform-class failure
   (superseded isolate, memory-limit reset, platform transient) preserves
   the failing job and re-throws, deferring the _remaining_ due jobs to
   the platform's alarm retry. This is deliberate: platform failures are
   properties of the isolate, not the job, so later jobs would fail the
   same way, and the retry runs on a fresh invocation.

Everything else about drive order — in particular the interleaving of
different owners' jobs within one alarm cycle — is unspecified. Owners may
not depend on cross-owner ordering; lanes, fairness, or parallel dispatch
of independent owners can arrive later without a contract change. At-least-once
delivery is the only delivery guarantee: a crash between a job's side
effects and its outcome re-runs the job, so `onJob` must be replay-safe.

## The event loop

The loop lives in its own module: `lifecycle/job-queue.ts` holds the pure
SQL queue, `lifecycle/job-driver.ts` holds the drive policy (`JobDriver`),
and `Lifecycle` wires them to the host and capabilities through the narrow
`JobDriverOptions` contract while keeping only the alarm entry point.

`Lifecycle.alarm()`:

1. Ensure startup.
2. If jobs are due: arm the **deadman pre-alarm** (now + 30s) so an isolate
   death mid-drive still wakes the object; the final re-arm overwrites it.
3. Drive due jobs (`time <= now`, ordered by time). For each:
   - stop if alarms were disabled mid-phase (host teardown);
   - a single-flight job whose previous run is in flight is skipped until it
     crosses its hung timeout, then forcibly re-run;
   - dispatch `onJob` inside `tryN` using the job's retry options (defaults
     3 attempts / 100 ms base / 3000 ms cap);
   - platform-class failures (superseded isolate, platform transient on
     exhaustion, memory-limit reset) preserve the job and re-throw so the
     platform retries a fresh invocation or the breaker engages;
   - terminal application failures reach `onJobError`, whose drive result
     decides advancement (recurring schedules reschedule; one-shots
     complete);
   - the drive result is applied: delete, retime, or leave due.
4. Run host `onAlarm()`.
5. Await the promises registered through `trackAlarmWork()` as one bounded
   alarm batch. The deadman remains armed while they settle.
6. Re-arm the physical alarm from queue state.

Startup and steps 3–5 run inside the alarm memory-limit circuit breaker
(initialization included because a severe reset can be thrown during boot
hydration, before any job runs — the original #1825 case), moved here from
`Agent.alarm()`. Registered work is aggregated at this boundary: all of it must
settle without a memory reset before the alarm clears prior strikes; any memory
reset enters the breaker once for the whole alarm. The durable strike counter
(`cf_agents:oom_alarm_strikes`)
tolerates `maxAlarmMemoryLimitStrikes` consecutive resets (composition-root
aperture; default 3), backs off the executing job, then seals — purging the
executing job and invoking the host's `onAlarmMemoryLimit()` hook. After a
strike is fully recorded (writes synced), the breaker schedules an isolate
reset via `ctx.abort(reason, { retryAlarm: false })` so the next attempt
runs with a reclaimed memory footprint and the platform does not retry the
handled alarm — the backoff alarm owns the next wake. Agent keeps only the
pending-destroy preamble in its own `alarm()`, and its `destroy()` uses the
same no-retry abort so a completed teardown's alarm is never re-run against
a constructor that would recreate the deleted schema.

## Scheduler on the queue

Scheduler keeps its entire public API and loses its storage and loop. A
schedule is one job whose `fn` is the callback name and whose payload carries
the timing vocabulary (`{ payload, type, cron?, intervalSeconds?,
delayInSeconds?, owner_path?, owner_path_key? }`); interval schedules are
single-flight jobs. `onJob` emits `schedule:execute` / `schedule:retry`,
dispatches the callback through the host invocation boundary (or routes to
the owning facet, which applies its own local retry budget), and returns the
recurrence outcome. `onJobError` emits `schedule:error`, runs the `onError`
observer, and advances recurring schedules. An idempotent push that
deduplicates still calls `jobs.rearm()` so a lost alarm recovers.

`schedule:duplicate_warning` is no longer emitted; Lifecycle logs a generic
`job:backlog_warning` when one capability has an unusually large due batch.

## Host-owned jobs

Agent's pull contributions became pushed jobs, synchronized with durable
state by `_syncHostJobs()` (called on startup, on state changes that used to
trigger an alarm recalculation, and after each alarm's housekeeping):

- `cf:keep-alive` — held while keep-alive refs exist; reschedules every
  `keepAliveIntervalMs`; cancelled at zero refs.
- `cf:housekeeping` — held while fiber-recovery or facet-run state exists;
  reschedules with the existing backoff math; completes when idle.
- `cf:destroy` — exclusive; re-derived from the durable `DESTROY_PENDING_KEY`
  marker on every sync (covering markers written by pre-queue releases), so
  a keepAlive-holding agent cannot delay its own condemnation. The marker
  stays authoritative: Agent's alarm preamble consumes it before Lifecycle
  startup.
- `think:workflow-notifications` — Think's wake for its notification drain,
  replacing the removed `_getExtensionAlarm()`.

Agent housekeeping continues to run on every alarm via its `onAlarm`
wrapper; the host jobs exist to guarantee the wakes.
