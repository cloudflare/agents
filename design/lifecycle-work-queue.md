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
5. Re-arm the physical alarm from queue state.

Steps 3–4 run inside the alarm memory-limit circuit breaker, moved here from
`Agent.alarm()`: the durable strike counter (`cf_agents:oom_alarm_strikes`)
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
