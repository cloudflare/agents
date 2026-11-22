# Fibers

A fiber is a closure that runs once, checkpoints with `stash()`, and hands
an interruption to a recovery hook. `Agent.runFiber()`, `startFiber()`,
`stash()`, `inspectFiber()`, `listFibers()`, `cancelFiber()`,
`resolveFiber()`, `deleteFibers()` and the `onFiberRecovered()` hook are the
public API. Since this change they are one-line delegates to the `Fibers`
Lifecycle capability in `packages/agents/src/fibers/`. The capability is
internal: Agent installs it, nothing else does yet.

[Tasks](./rfc-fibers.md) is the replayable engine: a named handler re-runs
from its step journal. Fibers are the other shape and stay separate (see
"Why not Tasks" below).

## How it works

### Storage

Two tables, owned by the capability and created on first use under the KV
key `cf_agents:fibers_schema_version`:

- `cf_agents_runs`: one row per fiber whose body has started and not
  settled. Inserted before the body runs, deleted after it settles.
  `stash()` writes the snapshot here, synchronously. If the delete fails
  after the body settled, the row keeps `completed_at` and `outcome`, and
  the next scan deletes it without calling the hook (#2305).
- `cf_agents_fibers`: the managed ledger for `startFiber()`. Id, unique
  idempotency key, name, status, snapshot, metadata, error, timestamps.
  Kept until `deleteFibers()` removes it.

### What is durable and what is in memory

| Durable (SQLite)             | In memory (lost on eviction)               |
| ---------------------------- | ------------------------------------------ |
| run rows and their snapshots | the closure itself                         |
| managed ledger rows          | the AbortController behind `cancelFiber()` |
| the recovery wake job        | the set of fibers running in this isolate  |
|                              | `waitForCompletion` waiters                |

A body runs at most once. After an eviction it never runs again: the
recovery hook gets the last snapshot and decides. The hook runs at least
once per interrupted row: an unmanaged row whose hook throws stays and is
retried until `fiberRecoveryMaxAgeMs`; a managed row is marked `error`.

### Recovery

A scan reads `cf_agents_runs`, skips fibers running in this isolate, and
for each other row calls the host's internal recovery first
(`_handleInternalFiberRecovery`, bounded by `fiberRecoveryHookTimeoutMs`)
and then `onFiberRecovered()`, both inside the host invocation context. It
then marks managed ledger rows with no run row (accepted, never started)
`interrupted` and recovers them the same way. One scan runs at a time; a
caller that arrives during a scan joins it. So a user `onFiberRecovered()` that never
returns holds every later recovery wake, as it already held startup.
Only the internal hook has a timeout.

Agent runs a scan during startup, before the user's `onStart()`, so chat
recovery sees its budgets before user code changes them.

### The wake

One Lifecycle job, `fibers:recover`, wakes the object for the scan:

- While any fiber runs in this isolate it is due every `heartbeatMs`
  (Agent passes `keepAliveIntervalMs`). That alarm is also what keeps the
  object alive: fibers take no `keepAlive()` ref.
- With orphaned rows left it is due now. After a scan that recovered
  nothing it backs off: `heartbeatMs * 2^n`, at most 5 minutes, reset by
  any scan that made progress.
- With nothing left it is cancelled.

A facet has no alarm slot. Its Fibers capability routes the wake to the
root through `lifecycle.routes` (`syncWake`), and the root's Fibers keeps a
mirror job `fibers:recover:<owner key>`. When the mirror fires, the root
routes `recover` to the facet, which scans and returns its next wake; the
root re-times or drops the mirror. A mirror whose facet is gone is dropped.
Deleting a facet subtree cancels its mirrors
(`__DO_NOT_USE_WILL_BREAK__cleanupRoutePrefix`). This is the same scheme
Tasks uses for routed runs.

Before this change the root kept an index table, `cf_agents_facet_runs`,
and Agent's `housekeeping` host job scanned it on every alarm. The root's
Fibers capability moves any rows left in that table onto mirror jobs due
now when it starts, then drops the table.

### Observability

Events keep their names and payloads (`fiber:run:started`, `completed`,
`failed`, `interrupted`; `fiber:recovery:detected`, `attempt`, `handled`,
`skipped`, `failed`). They go through `lifecycle.events`, which Agent
forwards to its observability sink. The per-statement storage spans Agent
used to open around fiber writes are gone.

## Key decisions

### Why not Tasks

A Task handler is named, declared on every wake, and replayed from a step
journal. A fiber is an inline closure that cannot be found again after an
eviction, so recovery is a hook with a checkpoint, and a managed fiber left
`interrupted` can be settled from outside later (`resolveFiber()`). To run
fibers on Tasks, Tasks would need a mutable checkpoint, settling a run from
outside after it ended, and claims with no deadline. That makes Tasks worse
and fibers no simpler. Both use the Lifecycle job queue.

### The wake is the heartbeat

The old engine held an Agent `keepAlive()` ref per fiber and relied on
Agent's housekeeping scanning on every alarm. Now the capability owns one
job whose due time is derived from its own rows and in-memory set. Agent's
`_syncHostJobs()` no longer knows about fibers, and facets stop taking a
root keepAlive ref per fiber.

## Tradeoffs

- Two tables stay for now. About sixty tests in agents, ai-chat and think
  insert `cf_agents_runs` rows to fake an interrupted chat turn on a facet.
  When the chat turn stops using the legacy fiber path, the two tables merge
  into one with a `retain` flag.
- An orphan in a live isolate (cleanup failed) is scanned right away rather
  than after a heartbeat. That is the only way such a row appears outside
  startup, and its body is done, so the scan only deletes it.

## History

- [rfc-fibers.md](./rfc-fibers.md): Tasks, which started under the name
  "Fibers".
