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

Five named rules define what a job owner can and cannot rely on:

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
3. **Newer pushes win over drive results.** Every change of a job's
   durable intent (`push()`, `reschedule()`, `cancel()`, the breaker's
   retimes), and a takeover of a hung single-flight job, bumps its
   in-memory revision, which exists only while a dispatch of that job is
   in flight. A dispatch records the revision when it claims the job; a
   retry runs, and `applyOutcome` applies a drive result, only while the
   revision is unchanged. Another dispatch of the
   same unchanged job (overlapping alarms) does not bump it. Each dispatch
   still sets the durable `running` marker, which single-flight skipping
   and hung recovery read. The drive loop also refetches each
   due job before claiming it, so a job replaced earlier in the same
   alarm cycle dispatches with fresh data — or, if no longer due, is
   skipped. An owner can therefore never lose a wake it explicitly
   pushed mid-drive. Owners that both push and return outcomes for the
   same job (Tasks) should derive both from the same durable state so
   they always agree.
4. **A reset stops the drive loop; a transient failure holds back only
   its owner.** A superseded isolate, a storage reset or a memory-limit
   reset condemns the isolate: the driver preserves the failing job and
   re-throws, and the remaining due jobs wait for a fresh invocation (or
   the breaker engages). A downstream stub's upgrade error matches the same
   pattern and also stops the loop; the two cannot be told apart. Any other
   platform-class failure (a `retryable` error, "Network connection lost.")
   belongs to something the job called. The driver keeps that job and its
   time, skips the rest of that owner's due jobs, and drives every other
   owner's. The alarm re-arms with the held owner's jobs no sooner than
   30 s out, and then still fails, so the failure is visible. Keeping the
   times keeps an owner's order: a Queue item behind a deferred one does
   not run first, and `list()` order does not change. Before this rule, one
   such job stopped every job behind it, of every owner, for as long as the
   downstream kept failing.
5. **Unreported attempts are counted durably.** Before each dispatch
   attempt the driver adds one to the row's `attempts` column and yields
   one macrotask so the write starts; when the attempt ends in any way the
   driver sees (a result, an application error, a platform failure) it
   takes the one off again. A started write survives a CPU-limit kill or
   `ctx.abort()` that follows; `storage.sync()` would also work but costs
   about 38 ms per dispatch. So the column counts only attempts that took
   their isolate down (CPU limit, the 15-minute alarm wall-time limit, a
   reset), and `context.attempt` is that count plus this invocation's
   attempt. When a job starts with `max(maxAttempts, 3)` of them, an owner
   with `onJobError` gets a `JobAttemptsExhaustedError` and decides the
   outcome; an owner without one keeps its job (it may be the owner's only
   wake), and each further attempt first moves the job out by 30 s,
   doubling to an hour. The floor of 3 is for deploys: a reset mid-attempt
   also goes unreported, and a one-attempt job must survive one. A push or
   a non-final outcome (`rescheduleAt`, `"yield"`) starts the count at
   zero. Retries within one invocation stay bounded by `maxAttempts`.
   Without this, a job that exceeded the CPU limit ran again every 30 s
   forever with `attempt: 1` (measured on a deployed Worker, 22 Nov 2026).

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

1. If the queue holds jobs: arm a **startup fallback alarm** at the next
   job's time, but no sooner than now + 30s, so a startup that throws (or an
   isolate that dies mid-startup) still leaves a wake, whether or not the
   platform's own alarm retries run, and is retried then. Then ensure
   startup. Queue mutations during startup defer their re-arm until startup
   ends; if startup throws after one, `Lifecycle` arms the same fallback from
   the current queue (on alarm and request paths alike), so jobs pushed
   during a failed startup keep a wake.
2. If jobs are due: arm the **deadman pre-alarm** (now + 30s) so an isolate
   death mid-drive still wakes the object; the final re-arm overwrites it.
3. Drive due jobs (`time <= now`, ordered by time). For each:
   - stop if alarms were disabled mid-phase (host teardown);
   - a single-flight job whose previous run is in flight is skipped until it
     crosses its hung timeout, then forcibly re-run;
   - a job with `max(maxAttempts, 3)` unreported attempts goes to
     `onJobError` (or, with no `onJobError`, is backed off and run once);
   - dispatch `onJob` inside `tryN` using the job's retry options (defaults
     3 attempts / 100 ms base / 3000 ms cap), counting each attempt in the
     row and yielding one macrotask first;
   - a reset or memory-limit failure preserves the job and re-throws so a
     fresh invocation runs the rest or the breaker engages; any other
     platform-class failure (on exhaustion) holds back that job's owner for
     30 s, keeping its jobs' times, and the loop goes on with other owners;
     the alarm re-throws it after re-arming;
   - terminal application failures reach `onJobError`, whose drive result
     decides advancement (recurring schedules reschedule; one-shots
     complete);
   - the drive result is applied: delete, retime, or leave due.
4. Run host `onAlarm()`.
5. Clear the memory-limit strike counter, unless work registered through
   `trackAlarmWork()` is still outstanding.
6. Re-arm the physical alarm from queue state.

Startup and steps 3–5 run inside the alarm memory-limit circuit breaker
(initialization included because a severe reset can be thrown during boot
hydration, before any job runs — the original #1825 case), moved here from
`Agent.alarm()`. Registered work extends that boundary past the alarm's
return: a memory reset it reports records a strike against the job that
registered it (one strike per reset, however many flows observe it), and the
strike counter clears only once no registered work is outstanding and the last
of it settled clean. The durable strike counter
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

Agent's pull contributions became pushed jobs, and then moved into
capabilities. Agent pushes none now. Jobs earlier releases left under the
`host` owner complete when they fire; on a facet, which has no alarm, Agent
drops them on start (#2299):

- `cf:keep-alive` — gone. Keep-alive is the `KeepAlive` capability
  (`lifecycle/keep-alive.ts`): one `keep-alive:heartbeat` job held while holds
  are open, re-timed every `keepAliveIntervalMs`, cancelled at zero holds. A
  routed Lifecycle takes its hold on the root's KeepAlive through
  `routes.toRoot`.
- `cf:housekeeping` — no longer pushed. Fiber recovery moved to the
  `Fibers` capability's own `fibers:recover` job ([fibers.md](./fibers.md));
  nothing replaces the old job.
- `cf:destroy` — moved to the internal `DeferredDestroy` capability
  (`lifecycle/deferred-destroy.ts`) as `deferred-destroy:wake`: exclusive,
  re-armed from the durable `cf_agents_destroy_pending` marker on every start
  (markers written by earlier releases included), so a keepAlive-holding
  agent cannot delay its own condemnation. The marker stays authoritative:
  Agent's alarm preamble reads it before Lifecycle startup.
- `think:workflow-notifications` — gone; Think's notifications are Outbox
  deliveries.
