# Lifecycle work queue

Lifecycle owns the Durable Object's queue of durable work, not just its
physical alarm timestamp. Capabilities and the host push work items into the
queue; Lifecycle runs the alarm as an event loop that executes due items,
applies retry policy, and re-arms the physical alarm from queue state.

This replaces the pull-based alarm-contribution model (`getNextAlarm()` +
capability `onAlarm()`), which is removed. See `alarm-coordination.md` for the
current contract; this document is the specification for the replacement.

## Domain model

- **Physical alarm** — the single timestamp stored by the Durable Object
  runtime. Only Lifecycle reads or writes it, always derived from queue state.
- **Work item** — one durable row in the Lifecycle-owned queue: an id, the
  owning capability, a due time, an opaque payload, and queue policy (retry
  options, single-flight overlap protection, exclusive arming).
- **Work outcome** — what the owner tells Lifecycle after an item runs:
  complete (delete), reschedule at a time, or retain (leave due).
- **Scheduler** — the user-facing vocabulary for named callbacks (cron,
  interval, delayed, dated). It validates, resolves callbacks, and pushes work
  items; it no longer owns a table or a due-row loop.

## Storage

Lifecycle owns one table, created lazily on first use:

```sql
CREATE TABLE IF NOT EXISTS cf_agents_lifecycle_work (
  id TEXT PRIMARY KEY NOT NULL,
  capability TEXT NOT NULL,           -- capability id, or 'host'
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
(rows become work items with `capability = 'scheduler'`; the old table is then
dropped). Times convert from seconds to milliseconds during migration.

## Capability surface

`LifecycleServices.alarms` (`rearm()` / `disabled()`) is removed. In its place
every capability receives `work`, scoped to its capability id:

```ts
type LifecycleWork = {
  push(options: {
    time: number;                 // epoch ms
    payload?: unknown;
    id?: string;                  // provided id upserts (replace)
    retry?: RetryOptions;
    singleflight?: boolean;       // skip while a prior run is in flight
    hungTimeoutSeconds?: number;  // single-flight hang cutoff
    exclusive?: boolean;          // suppress ordinary alarm candidates
  }): Promise<LifecycleWorkItem>;
  cancel(id: string): Promise<boolean>;
  reschedule(id: string, time: number): Promise<boolean>;
  get(id: string): LifecycleWorkItem | undefined;   // sync SQL read
  list(): LifecycleWorkItem[];                      // sync SQL read
};
```

Every queue mutation re-arms the physical alarm automatically (deferred and
coalesced during startup, as rearm already was). Capabilities never call a
rearm explicitly.

Hooks replace `onAlarm`/`getNextAlarm`:

```ts
onWork?(context: { item: LifecycleWorkItem; attempt: number }):
  MaybePromise<LifecycleWorkOutcome | void>;
onWorkError?(context: { item: LifecycleWorkItem }, error: unknown):
  MaybePromise<LifecycleWorkOutcome | void>;

type LifecycleWorkOutcome =
  | undefined              // complete: delete the item
  | { rescheduleAt: number }  // epoch ms
  | "retain";              // leave the item due for a later cycle
```

The host implements the same hooks for host-owned work (items pushed through
`lifecycle.work`, dispatched with `capability = 'host'` inside the host
invocation boundary). Host `onAlarm()` survives: it runs once per alarm
invocation after due work is processed. Host `getNextAlarm()` is removed.

## The event loop

`Lifecycle.alarm()`:

1. Ensure startup.
2. Select due items (`time <= now`, ordered by time). For each:
   - stop if alarms were disabled mid-phase (host teardown);
   - a single-flight item whose previous run is still in flight is skipped
     until it crosses its hung timeout, then forcibly re-run;
   - dispatch to the owner's `onWork` inside `tryN` using the item's retry
     options (defaults 3 attempts / 100 ms base / 3000 ms cap);
   - platform-class failures (superseded isolate, platform transient on
     exhaustion, memory-limit reset) preserve the item and re-throw so the
     platform retries a fresh invocation or the breaker engages;
   - application failures after retry exhaustion call the owner's
     `onWorkError`, whose outcome decides advancement (recurring schedules
     reschedule; one-shots complete);
   - the outcome is applied: delete, retime, or retain.
3. Run host `onAlarm()`.
4. Re-arm the physical alarm from queue state.

Steps 2–3 run inside the alarm memory-limit circuit breaker, moved here from
`Agent.alarm()`: a durable strike counter (`cf_agents:oom_alarm_strikes`)
tolerates `maxAlarmMemoryLimitStrikes` consecutive memory-limit resets (set by
the composition root; default 3), backing off the executing item, then seals —
purging the executing item and invoking the host's `onAlarmMemoryLimit()`
hook so domain policy (chat recovery sealing) can land. Everything else
re-throws unchanged. Agent keeps only the pending-destroy preamble in its own
`alarm()`.

Re-arm computation is pure SQL over the queue: the earliest exclusive item if
any exist, otherwise the earliest ready item (clamped to the future) merged
with the earliest hung-timeout recheck for in-flight single-flight items.

## Scheduler on the queue

Scheduler keeps its entire public API (`set`, `every`, `get`, `list`,
`cancel`, registered callback maps, retry and hung-interval options, owner
routing for facets, events) and loses its storage and loop. A schedule is one
work item whose payload carries `{ callback, payload, type, cron?,
intervalSeconds?, delayInSeconds?, owner_path?, owner_path_key? }`; interval
schedules are single-flight items. `onWork` emits `schedule:execute` /
`schedule:retry`, dispatches the callback through the host invocation
boundary (or routes to the owning facet), and returns the recurrence outcome.
`onWorkError` emits `schedule:error`, runs the `onError` observer, and
advances recurring schedules.

`schedule:duplicate_warning` is no longer emitted; Lifecycle logs a generic
backlog warning when one capability has an unusually large due batch.

## Host-owned work on the queue

Agent's pull contributions become pushed items:

- `cf:keep-alive` — pushed while keep-alive refs are held, rescheduling every
  `keepAliveIntervalMs`; cancelled at zero refs.
- `cf:housekeeping` — pushed when fiber-recovery or facet-run state exists;
  reschedules with the existing backoff math; completes when idle.
- `cf:destroy` — exclusive item armed by `_cf_scheduleDestroy()`. The durable
  `DESTROY_PENDING_KEY` marker remains authoritative; Agent's alarm preamble
  still checks it before Lifecycle startup.
- Think's workflow-notification wake is a Think-owned host item replacing
  `_getExtensionAlarm()`, which is removed.

Agent housekeeping continues to run on every alarm via its `onAlarm` wrapper;
the host items exist to guarantee the wakes.
