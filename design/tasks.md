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

## Memory

Per isolate: one abort controller and one promise per running attempt (`#active`, removed when the attempt ends). `local` lives only on the attempt that received it. Nothing is cached per run beyond that; `list` pages.

## The chat turn

The chat-turn definition (`chat/turn-task.ts`) passes the turn's closure as `local` and keeps the turn's stash envelope in the checkpoint entry `snapshot`. A turn accepted by a version before checkpoints kept the envelope in storage under `__cf_chat_turn_snapshot:chat_<nonce>`; its recovery reads that key once when no checkpoint entry exists, then deletes it.
