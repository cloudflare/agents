# Tasks event mailbox

This change adds durable, run-scoped external events to `agents/tasks`.

## Before and after

| Area              | Before                                          | After                                                                                     |
| ----------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| External input    | A run only received its initial input.          | `Tasks.sendEvent()` can deliver input to an existing non-terminal run.                    |
| Waiting           | Steps could wait on sleeps and retries.         | `step.waitForEvent()` can wait for an exact event type, indefinitely or with a timeout.   |
| Buffered input    | No run mailbox existed.                         | Events sent before or during execution remain buffered until consumed.                    |
| Batch consumption | Not available.                                  | `step.takeEvents()` consumes a bounded FIFO batch without waiting.                        |
| Replay            | Replayed `do` and sleep steps.                  | Event results are journaled, so replay returns the same delivery without consuming again. |
| Scheduling        | Every waiting run had a deadline and queue job. | Indefinite event waits have no deadline or per-run wake job; matching events create one.  |
| Storage           | Run and step tables.                            | Added an event table and expanded step journals with event kinds and types.               |
| Schema            | Tasks schema version 1.                         | Tasks schema version 2 with a crash-safe v1-to-v2 migration.                              |

## Existing Tasks behavior adjusted

This change is primarily additive, but it also adjusts three internal paths:

- Tasks storage upgrades from schema v1 to v2 while preserving existing runs
  and step history.
- Startup removes stale wake jobs left by indefinite event waits.
- Routed Task wakes use a separate internal ID namespace. Surviving legacy
  routed rows migrate by their stored owner identity, while local wake IDs
  remain unchanged. Startup reconciles routed wakes before requesting one
  coalesced root-alarm derivation.

Existing `step.do()`, sleep, retry, cancellation, replay, and local wake
behavior are unchanged.

## Input timing

The run mailbox supports input regardless of handler timing. If a run is
already waiting for an event, delivery wakes it immediately. If the run is
pending or actively working, the event remains buffered until a later
`waitForEvent()` or `takeEvents()` step consumes it.

"Unprompted" input must still target a known, non-terminal run. The mailbox is
not a general-purpose inbox.

## Public API

```ts
await tasks.sendEvent(
  runId,
  "approval",
  { approved: true },
  { idempotencyKey: "approval:1" }
);
```

`sendEvent()`:

- Accepts JSON payloads whose complete event envelope fits the existing 1 MiB
  serialization limit.
- Matches event types exactly and case-sensitively.
- Buffers events for pending, running, or waiting runs.
- Supports run-scoped idempotency keys up to 256 characters.
- Rejects non-finite numbers instead of silently persisting them as `null`.
- Returns `{ eventId, type, payload, createdAt, accepted }`.
- Throws for a missing run or a new delivery to a terminal run.

A failure after validation can be ambiguous because event insertion commits
before wake synchronization. Retrying the same retained run, type, serialized
payload, and idempotency key returns the original receipt, including after the
run settles.

```ts
const event = await step.waitForEvent<{ approved: boolean }>(
  "wait-for-approval",
  "approval"
);
```

`waitForEvent()`:

- Consumes the oldest unconsumed event of the requested type.
- Waits indefinitely when options are omitted.
- Keeps no per-run Lifecycle wake job for an indefinite wait.
- Accepts `{ timeout }`; a timed wait returns `null` on expiry.
- Only consumes events accepted by the persisted timeout deadline.
- Replays the original journaled event or timeout result.

```ts
const events = await step.takeEvents<{ text: string }>(
  "current-messages",
  "message",
  { limit: 50 }
);
```

`takeEvents()`:

- Never waits.
- Returns currently buffered matching events in FIFO order.
- Defaults to 100 events and allows at most 1,000.
- May return fewer than the count limit to keep the journaled batch under 1 MiB.
- Journals the result, including an empty array.

## Storage

The new `cf_agents_task_events` table stores:

```text
sequence              FIFO ordering key
event_id              stable public event ID
run_id                target Task run
type                  exact event type
payload               serialized JSON payload
serialized_size       byte size of the complete journaled event envelope
idempotency_key       optional run-scoped deduplication key
consumed_step_name    step that consumed the event
created_at            durable acceptance time
consumed_at           consumption time, or NULL while available
```

`event_id` is a stable, collision-resistant public ID, with uniqueness
enforced in the owning Tasks capability. `(run_id, idempotency_key)` is unique
when a key is provided. Available events are indexed by run, type, consumption
state, and sequence.

The existing `cf_agents_task_steps` table adds the `wait_event` and
`take_events` kinds. Its new `event_type` column persists the exact type
expected by an event step so replay can detect divergence.

The migration rebuilds the step table because SQLite cannot directly alter
its `kind` check constraint. Existing step rows are copied unchanged. Startup
also inspects the actual SQLite schema instead of relying only on the KV
version marker, covering a crash between SQL migration and marker update.

## Delivery flow

```text
Application
+-- Tasks.sendEvent(runId, type, payload, options)
    +-- validate type and serialize payload
    +-- begin synchronous SQLite transaction
    |   +-- verify run exists and is non-terminal
    |   +-- deduplicate or reject an idempotency conflict
    |   +-- insert event into cf_agents_task_events
    |   +-- if a matching event wait is parked, make the run due
    +-- emit task:event:received
    +-- synchronize the Lifecycle wake job when needed
```

## Wait flow

```text
Task definition
+-- step.waitForEvent(name, type, options?)
    +-- replay completed journal entry if present
    +-- consumeEventStep()
    |   +-- begin generation-fenced SQLite transaction
    |   +-- select the oldest available matching event
    |   +-- timed wait: exclude events accepted after its deadline
    |   +-- event found
    |   |   +-- mark event consumed
    |   |   +-- journal the event result atomically
    |   +-- no event and deadline expired
    |   |   +-- journal null atomically
    |   +-- no event and still waiting
    |       +-- journal waiting state without consuming anything
    +-- suspend the run when still waiting
        +-- recheck the mailbox immediately before parking
        +-- set next_at to NULL for an indefinite wait
        +-- remove its Lifecycle wake job
```

The recheck closes the race where an event arrives after the handler starts
unwinding but before the run changes from `running` to `waiting`.

## Replay after process loss

```text
Consume event and journal result
              |
              v
       Begin following step
              |
              X process dies
              |
              v
       Reclaim Task run
              |
              v
   Replay handler from the top
              |
              v
 Completed event step journal exists
              |
              v
 Return the original event without consuming again
```

## Correctness guarantees

- Event insertion is durable before `sendEvent()` resolves, but a later wake
  synchronization failure can reject after insertion committed.
- Every accepted event is small enough to journal and replay.
- Batch selection uses event IDs and sizes to choose the byte-bounded prefix
  before loading payload rows into JavaScript memory.
- Consumption and step journaling commit in one synchronous transaction.
- Generation fencing prevents superseded executions from consuming events.
- Event delivery is FIFO within an exact event type.
- Completed event steps consume once and replay from their journal.
- Events arriving during active work do not interrupt that work.
- The park-time mailbox recheck prevents lost wakeups.
- Timed waits persist their first deadline across replay and deployments.
- Events accepted after a timed wait deadline remain unconsumed.
- Deleting a retained run also deletes its events.

## Module responsibilities

```text
types.ts
   | public API shapes
   v
tasks.ts
   | sending, deduplication, run wake and park coordination
   v
replay.ts
   | handler-facing wait/take behavior and replay rules
   v
engine-port.ts
   | atomic mailbox selection, consumption and journaling
   v
store.ts
   | SQLite schema, transactions and migration
   v
Durable Object SQLite
```
