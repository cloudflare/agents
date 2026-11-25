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

`step.checkpoint.get(key)` and `step.checkpoint.set(key, value)` keep JSON state the next attempt reads. The entries are one JSON object in the run row's `checkpoint` column. A write is one synchronous `UPDATE` of that row (`json_set`), fenced on the attempt's generation: once a newer attempt claimed the run, the write does nothing. A read costs no statement: the attempt parses the column once from the row its claim read (only that attempt writes the column until it ends, every write being fenced) and keeps each entry as JSON in memory, updated by its own writes. The terminal update clears the column in the same statement, unless the definition is registered with `keepCheckpoint: true` (managed fibers are inspected with their last snapshot); then it stays until the run is deleted. Host code reads an entry with `checkpointOf(runId, key)`. One column instead of a table of its own: a set and a settle write one row less each, at the price of sharing the run row's size limit with its metadata and result (a chat turn's snapshot and a fiber's stash are small). Schema 4 moved schema 2–3's `cf_agents_task_checkpoint` rows into the column and dropped the table.

Two ways to record progress, and no third:

- `step.do(name, fn)` is for work that must not repeat: its result is journaled and returned on replay.
- `step.checkpoint.set(key, value)` is for state a later attempt reads: the last value wins.

## Lanes (internal)

`run(..., { lane })`: runs of one lane run one at a time, in the order they were accepted (`seq`). A run queued behind its lane's open run has no deadline and no wake job; the head settling gives the next one a deadline of now. An interrupted head is the oldest open run, so it runs again before what is queued behind it. `holdLane(lane)` keeps a lane's runs from starting in this isolate (Think holds its submissions lane while chat recovery decides who owns an interrupted turn); `clear(lane, reason)` ends every open run of the lane `skipped`, writing before its first await.

Arrival policies (`TaskRunOptions.policy`, only with `lane`): `queue` (default) waits its turn; `latest` ends `skipped` the lane's runs that have not started (`pending`, attempt 0), and the started one too for a definition registered with `supersedeRunning` (its signal aborts), and lists them in the receipt's `superseded`; `drop` at a busy lane stores nothing and returns `dropped: true`; `{ debounceMs }` is `latest` whose run also waits `debounceMs` from its arrival when it is at the lane's front (behind a started run it starts when that one ends). `front: true` places a run ahead of the runs that have not started, behind a started one (a tool answer the running turn waits for). Merging requests is the caller's: it reads the superseded runs before or after `run()`. Nothing about a policy is stored: it acts at arrival and leaves `skipped` runs and sequence numbers.

## Framework definitions: reports, attempt cap, settlements (internal)

`register(name, handler, { onStatus, maxAttempts, keepCheckpoint, claimMs, attached })`:

- `onStatus(record)` gets the run's stored record and runs in host context when a run is accepted (before its wake is published, so the run starts only after it), when an attempt claims it, and when it ends. The terminal call happens at least once: `notified` takes the status after it returns; a throw retries it 30 s later through the `tasks:reports` job, and a reset before the write delivers it again from the start. A `retain: false` run stays until its terminal report returned. Reports run inside the request or alarm that moved the run, so they need no keep-alive hold.
- A framework definition's input may be up to 16 MiB: past 500,000 UTF-16 code units it is stored in pieces in `cf_agents_task_parts (run_id, piece, data)`, never splitting a surrogate pair, and joined when the attempt or `inputOf` reads it. The pieces go with the run. Other definitions keep the 1 MiB value limit.
- `maxAttempts`: the claim is committed with `storage.sync()` before the handler runs, and a run whose attempts are spent ends `error` (`TaskInterruptedError`).
- `attached: true`: runs start only with `start: "now"` (another start throws), and no wake job is armed for the accept or the claim, because the attempt ends before its caller returns. A reset loses nothing: the next start makes the interrupted attempt due and wakes it then. Think's action effects and decisions use it, so an action call arms no alarm.
- The handler may return a `TaskSettlement`: `aborted`, `skipped`, `failed` (no retry), `park` (the run stays `pending` with wait reason `park`, no deadline, its lane held, until `settle()` ends it), or `retry(at)` (the run stays `pending` with wait reason `retry` until `at`, keeping its lane; the next attempt runs then, counted like any other). A handler returns `retry` rather than throwing because a throw would end the run `error` (no retry for a framework definition) and a `step.do` retry would write a journal row per attempt; `retry` writes none, shows no error status between attempts, and leaves the backoff and the give-up to the handler. Its next attempt counts against `maxAttempts` when the definition sets one. Deliveries use it (`design/deliveries.md`).
- `settle(runId, outcome, { checkpoint })` ends a run no attempt runs in this isolate (parked, or left `running` by a reset) with a settlement or a completing value, writing `checkpoint` entries under the same fence; a racing second settle gets `false`. This is the one way to settle from outside: fibers (`resolveFiber`) and approvals use it. Settled with `retry(at)`, the run is not ended but waits again, with the checkpoint written: the way a parked run is given what it waited for and run again (held deliveries use it).
- `claimMs`: how long an attempt's claim lasts before the run counts as interrupted. The claim's wake renews it while the attempt runs in this isolate, so that wake is also the object's keep-alive. Fibers set it to the keep-alive interval; omitted, it is the step timeout plus slack.
- `runDue(definition, deadline?)` runs the due runs of a definition now, one at a time; none starts after `deadline`, and it returns the first one it left. The Agent calls it at startup so interrupted fibers are recovered before `onStart`.
- `wait(runId)` resolves with the run's record after its terminal report; with the record as it is on a timeout, and with its last record when it is deleted (a report in flight resolves its waiters when it returns). Waiters belong to one run, not to its id.
- Host code reads records synchronously (`peek`, `peekByIdempotencyKey`, `peekList`), reads a run's input (`inputOf`), merges metadata (`updateMetadata`), deletes a terminal run (`deleteRun`) and carries runs forward from its own older storage (`importRun`, once per id, with checkpoint entries). `peekList` filters on an exact `input` (fibers list by name).

## Writes on the hot path

A run started now (`start: "now"`) outside a lane gets its first wake from the claim that follows at once, not from the accept; until then the row's deadline is the wake a restart reconciles. A finished run that nobody keeps (`retain: false`), reports or waits for is deleted in one fenced write instead of completed and then deleted; if that delete fails it is completed in place, so a finished attempt is never taken for an interrupted one (#2305).

## Wakes while an attempt runs, and around a terminal report

An alarm-driven attempt outlives its dispatch: the dispatch waits at most 5 s (`DISPATCH_BUDGET_MS`) and then hands the attempt off with `trackAlarmWork`. From then on, while the claimed run is `running`, its wake job is never more than 5 s away (`LIVE_WAKE_MS`), whatever its claim deadline: each wake that finds the attempt alive comes back as soon, and only moves the claim once half of it is used. That wake is what notices a reset that killed the attempt (#2847: a reset 10 s into a long submitted turn was picked up after 30 s instead of a few seconds). Each such wake costs the job row's claim and reschedule writes and one alarm write; the run row is written only when the claim moves. An `attached` attempt arms no wake (its caller holds it, and the next start recovers it), and a run the memory-limit breaker struck (its claim stripped, generation `NULL`) is not clamped: it waits out its backoff. A sub-agent's runs use its own queue and take the same path, woken through the root.

A terminal report must outlive a reset before it returns. A run with a wake job keeps it until the report returned (a due wake of a terminal, unreported run delivers the report); a run with none (queued in a lane, or parked and settled from outside) holds the `tasks:reports` job as a guard while its report runs. The guard is cancelled when the last guarded report returns, provided no report is owed to that job and no replay of owed reports is under way. A report that throws, a reset, or a batch of more than 100 owed reports keeps the job until it runs.

## Cancel

`cancel(runId)` settles the run `aborted` at once. A live attempt's signal aborts, and nothing that attempt writes afterwards lands (its generation no longer owns the run). A cancel requested while an attempt runs wins over the attempt's result. An attempt left behind by a cancel, or by a delete and a new run under the same id, does not count as the run's live attempt.

## Instances

`new Tasks({ name })` is a second Tasks in the same Durable Object, apart from the default (unnamed) one: its own runs, steps, input pieces, schema version and jobs. The names come from the Lifecycle's capability store, resolved once in the constructor: the default keeps `cf_agents_task_runs`, `cf_agents_task_steps`, `cf_agents_task_parts`, and the indexes `cf_agents_task_runs_{definition,idempotency_key,lane}`, byte for byte; a named instance `audit` has the same names with `__n_audit` at the end. Each instance's schema version is its entry in the Lifecycle's one schema record (`cf_agents:schema_versions`, under `tasks` or `tasks/audit`); the key each kept before (`cf_agents:tasks_schema_version`, `cf_agents:tasks/audit:tasks_schema_version`) is read once as the legacy version and deleted. Statements put the table name in their text (a `SqlName` the store's `sql` tag writes in place, never a bound value and never built from input), so the default's statements are today's. A named instance starts at the current schema version: the schema 1-3 migrations only ever apply to the default. Run ids, lanes and idempotency keys are unique within an instance, and a named instance's step idempotency keys start with its id (`tasks/audit:<run>:<step>`; the default's stay `<run>:<step>`) so an external service never sees one key for two instances' steps; `get`, `list`, `wait`, `cancel`, `clear(lane)` and `delete` see only that instance. A named instance that a deploy stops installing keeps its rows and its jobs (the job driver keeps an ownerless job and retries it); installed again, its runs continue.

## Memory

Per isolate: one abort controller and one promise per running attempt (`#active`, removed when the attempt ends); one `local` per run whose caller still waits for its first attempt (`#locals`), held for a queued lane run until its attempt here starts or it ends (bounded by the lane's open runs; a reset drops them, and a `local` with `dropped()` is told when its run ends first); one entry per live `wait()` (`#waiters`, removed on resolve, timeout or abort); the runs whose terminal report is being delivered (`#reporting`); the held lanes (`#heldLanes`, a handful of names). Nothing is cached per run beyond that; lists page.

## The chat turn

The chat-turn definition (`chat/turn-task.ts`) passes the turn's closure as `local`. The run's input carries the turn's snapshot in its stash envelope (`envelope`, left out when it cannot be kept as JSON or would not fit), and the checkpoint entry `stash` holds the app's latest `stash()` data. A replay hands recovery the envelope with that data. Older runs are still read: a run from before the input carried the snapshot has its whole envelope in the checkpoint entry `snapshot`, and a turn accepted before checkpoints kept it in storage under `__cf_chat_turn_snapshot:chat_<nonce>` (read once, then deleted).

## Fibers

`runFiber()` and `startFiber()` are one-step runs of `__cf_fiber` (`retain: false`) and `__cf_managed_fiber` (`keepCheckpoint: true`), defined in `fiber-runs.ts`. See [fibers.md](./fibers.md).
