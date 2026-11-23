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

`step.checkpoint.get(key)` and `step.checkpoint.set(key, value)` keep JSON state the next attempt reads. The entries are one JSON object in the run row's `checkpoint` column. A write is one synchronous `UPDATE` of that row (`json_set`), fenced on the attempt's generation: once a newer attempt claimed the run, the write does nothing. The terminal update clears the column in the same statement, unless the definition is registered with `keepCheckpoint: true` (managed fibers are inspected with their last snapshot); then it stays until the run is deleted. Host code reads an entry with `checkpointOf(runId, key)`. One column instead of a table of its own: a set and a settle write one row less each, at the price of sharing the run row's size limit with its metadata and result (a chat turn's snapshot and a fiber's stash are small). Schema 4 moved schema 2–3's `cf_agents_task_checkpoint` rows into the column and dropped the table.

Two ways to record progress, and no third:

- `step.do(name, fn)` is for work that must not repeat: its result is journaled and returned on replay.
- `step.checkpoint.set(key, value)` is for state a later attempt reads: the last value wins.

## Lanes (internal)

`run(..., { lane })`: runs of one lane run one at a time, in the order they were accepted (`seq`). A run queued behind its lane's open run has no deadline and no wake job; the head settling gives the next one a deadline of now. An interrupted head is the oldest open run, so it runs again before what is queued behind it. `holdLane(lane)` keeps a lane's runs from starting in this isolate (Think holds its submissions lane while chat recovery decides who owns an interrupted turn); `clear(lane, reason)` ends every open run of the lane `skipped`, writing before its first await.

## Framework definitions: reports, attempt cap, settlements (internal)

`register(name, handler, { onStatus, maxAttempts, keepCheckpoint, claimMs, attached })`:

- `onStatus(record)` gets the run's stored record and runs in host context when a run is accepted (before its wake is published, so the run starts only after it), when an attempt claims it, and when it ends. The terminal call happens at least once: `notified` takes the status after it returns; a throw retries it 30 s later through the `tasks:reports` job, and a reset before the write delivers it again from the start. A `retain: false` run stays until its terminal report returned. Reports run inside the request or alarm that moved the run, so they need no keep-alive hold.
- A framework definition's input may be up to 16 MiB: past 500,000 UTF-16 code units it is stored in pieces in `cf_agents_task_parts (run_id, piece, data)`, never splitting a surrogate pair, and joined when the attempt or `inputOf` reads it. The pieces go with the run. Other definitions keep the 1 MiB value limit.
- `maxAttempts`: the claim is committed with `storage.sync()` before the handler runs, and a run whose attempts are spent ends `error` (`TaskInterruptedError`).
- `attached: true`: runs start only with `start: "now"` (another start throws), and no wake job is armed for the accept or the claim, because the attempt ends before its caller returns. A reset loses nothing: the next start makes the interrupted attempt due and wakes it then. Think's action effects and decisions use it, so an action call arms no alarm.
- The handler may return a `TaskSettlement`: `aborted`, `skipped`, `failed` (no retry), or `park` (the run stays `pending` with wait reason `park`, no deadline, its lane held, until `settle()` ends it).
- `settle(runId, outcome, { checkpoint })` ends a run no attempt runs in this isolate (parked, or left `running` by a reset) with a settlement or a completing value, writing `checkpoint` entries under the same fence; a racing second settle gets `false`. This is the one way to settle from outside: fibers (`resolveFiber`) and approvals use it.
- `claimMs`: how long an attempt's claim lasts before the run counts as interrupted. The claim's wake renews it while the attempt runs in this isolate, so that wake is also the object's keep-alive. Fibers set it to the keep-alive interval; omitted, it is the step timeout plus slack.
- `runDue(definition, deadline?)` runs the due runs of a definition now, one at a time; none starts after `deadline`, and it returns the first one it left. The Agent calls it at startup so interrupted fibers are recovered before `onStart`.
- `wait(runId)` resolves with the run's record after its terminal report; with the record as it is on a timeout, and with its last record when it is deleted (a report in flight resolves its waiters when it returns). Waiters belong to one run, not to its id.
- Host code reads records synchronously (`peek`, `peekByIdempotencyKey`, `peekList`), reads a run's input (`inputOf`), merges metadata (`updateMetadata`), deletes a terminal run (`deleteRun`) and carries runs forward from its own older storage (`importRun`, once per id, with checkpoint entries). `peekList` filters on an exact `input` (fibers list by name).

## Writes on the hot path

A run started now (`start: "now"`) outside a lane gets its first wake from the claim that follows at once, not from the accept; until then the row's deadline is the wake a restart reconciles. A finished run that nobody keeps (`retain: false`), reports or waits for is deleted in one fenced write instead of completed and then deleted; if that delete fails it is completed in place, so a finished attempt is never taken for an interrupted one (#2305).

## Cancel

`cancel(runId)` settles the run `aborted` at once. A live attempt's signal aborts, and nothing that attempt writes afterwards lands (its generation no longer owns the run). A cancel requested while an attempt runs wins over the attempt's result. An attempt left behind by a cancel, or by a delete and a new run under the same id, does not count as the run's live attempt.

## Memory

Per isolate: one abort controller and one promise per running attempt (`#active`, removed when the attempt ends); one `local` per run whose caller still waits for its first attempt (`#locals`); one entry per live `wait()` (`#waiters`, removed on resolve, timeout or abort); the runs whose terminal report is being delivered (`#reporting`); the held lanes (`#heldLanes`, a handful of names). Nothing is cached per run beyond that; lists page.

## The chat turn

The chat-turn definition (`chat/turn-task.ts`) passes the turn's closure as `local` and keeps the turn's stash envelope in the checkpoint entry `snapshot`. A turn accepted by a version before checkpoints kept the envelope in storage under `__cf_chat_turn_snapshot:chat_<nonce>`; its recovery reads that key once when no checkpoint entry exists, then deletes it.

## Fibers

`runFiber()` and `startFiber()` are one-step runs of `__cf_fiber` (`retain: false`) and `__cf_managed_fiber` (`keepCheckpoint: true`), defined in `fiber-runs.ts`. See [fibers.md](./fibers.md).
