# Tasks: the durable-run engine

Status: the engine the Inbox, Fibers and the Outbox fold into (see the one-engine plan). This file records the internal pieces that are not in the public docs ([docs/agents/tasks.md](../docs/agents/tasks.md)) yet, and the rules they follow.

## Statuses

`pending | running | completed | error | aborted`. A run that ran and now sleeps or backs off is `pending` with `wait_reason` and `next_at`; there is no separate `waiting` status. Schema 2 renamed the stored values (`failed` to `error`, `cancelled` to `aborted`, `waiting` to `pending`) and the column (`state` to `status`) in one transaction.

## Starting a run

One method, `run(name, input, options)`. `options.start`:

- omitted: the first attempt starts in this invocation and `run()` does not wait for it;
- `"now"`: the first attempt runs in this invocation and `run()` resolves when it ends;
- `"alarm"`: the first attempt runs from the alarm, where `trackAlarmWork` keeps it inside the memory-limit breaker.

A definition from `register()` (a framework definition) joins an existing run of the same id or key whatever its input; a declared definition with a different input throws `TaskInputConflictError`.

## `local` (internal)

`options.local` is handed to the first attempt as `step.local` when that attempt runs in the caller's invocation. It is never stored. An attempt after a reset sees `undefined`, so a definition decides "live or recover" on `step.local`, never on the attempt number.

## The checkpoint (internal)

`step.checkpoint.get(key)` and `step.checkpoint.set(key, value)` keep JSON state the next attempt reads. Rows of `cf_agents_task_checkpoint (run_id, key, value)`. A write is synchronous and fenced on the attempt's generation: once a newer attempt claimed the run, the write does nothing. The rows are deleted when the run settles (with the run when `retain: false`), because nothing reads a settled run's checkpoint yet.

Two ways to record progress, and no third:

- `step.do(name, fn)` is for work that must not repeat: its result is journaled and returned on replay.
- `step.checkpoint.set(key, value)` is for state a later attempt reads: the last value wins.

## Lanes (internal)

`run(..., { lane })`: runs of one lane run one at a time, in the order they were accepted (`seq`). A run queued behind its lane's open run has no deadline and no wake job; the head settling gives the next one a deadline of now. An interrupted head is the oldest open run, so it runs again before what is queued behind it. `holdLane(lane)` keeps a lane's runs from starting in this isolate (Think holds its submissions lane while chat recovery decides who owns an interrupted turn); `clear(lane, reason)` ends every open run of the lane `skipped`, writing before its first await.

## Framework definitions: reports, attempt cap, settlements (internal)

`register(name, handler, { onStatus, maxAttempts })`:

- `onStatus(snapshot)` runs in host context when a run is accepted (before its wake is published, so the run starts only after it), when an attempt claims it, and when it ends. The terminal call happens at least once: `notified` takes the status after it returns; a throw retries it 30 s later through the `tasks:reports` job, and a reset before the write delivers it again from the start. A `retain: false` run stays until its terminal report returned.
- `maxAttempts`: the claim is committed with `storage.sync()` before the handler runs, and a run whose attempts are spent ends `error` (`TaskInterruptedError`).
- The handler may return a `TaskSettlement`: `aborted`, `skipped`, `failed` (no retry), or `park` (the run stays `pending` with wait reason `park`, no deadline, its lane held, until `settle()` ends it).
- `settle(runId, outcome)` ends a run no attempt runs in this isolate (parked, or left `running` by a reset) with a settlement or a completing value; a racing second settle gets `false`.
- `wait(runId)` resolves with the run's record after its terminal report; with the record as it is on a timeout, and with its last record when it is deleted (a report in flight resolves its waiters when it returns). Waiters belong to one run, not to its id.
- Host code reads records synchronously (`peek`, `peekByIdempotencyKey`, `peekList`), reads a run's input (`inputOf`), merges metadata (`updateMetadata`), deletes a terminal run (`deleteRun`) and carries runs forward from its own older storage (`importRun`, once per id).

## Cancel

`cancel(runId)` settles the run `aborted` at once. A live attempt's signal aborts, and nothing that attempt writes afterwards lands (its generation no longer owns the run). A cancel requested while an attempt runs wins over the attempt's result. An attempt left behind by a cancel, or by a delete and a new run under the same id, does not count as the run's live attempt.

## Memory

Per isolate: one abort controller and one promise per running attempt (`#active`, removed when the attempt ends); one `local` per run whose caller still waits for its first attempt (`#locals`); one entry per live `wait()` (`#waiters`, removed on resolve, timeout or abort); the runs whose terminal report is being delivered (`#reporting`); the held lanes (`#heldLanes`, a handful of names). Nothing is cached per run beyond that; lists page.

## The chat turn

The chat-turn definition (`chat/turn-task.ts`) passes the turn's closure as `local` and keeps the turn's stash envelope in the checkpoint entry `snapshot`. A turn accepted by a version before checkpoints kept the envelope in storage under `__cf_chat_turn_snapshot:chat_<nonce>`; its recovery reads that key once when no checkpoint entry exists, then deletes it.
