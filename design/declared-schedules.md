# Declared schedules

**Internal.** Not a public API. Nothing new from the slim-hosts work is exposed to apps until it has shipped inside `Think` and `AIChatAgent` for a release and is shown correct ([rfc-slim-hosts.md](./rfc-slim-hosts.md#exposure)). Sibling packages import it from `agents/internal`.

Recurring work that is part of the program (a weekly report, an hourly cleanup) is declared in code, not created at runtime. `declareSchedules(scheduler, source, options)` takes a set of named entries and keeps storage in line with it. Think's `getScheduledTasks()` is built on it.

## How it works

Code: `packages/agents/src/schedules/declared.ts` (reconcile, run, migration) and `declared-timing.ts` (the expression parser and next-occurrence maths).

Each declared name is one job in the Lifecycle job queue with id `declared:<name>` (`declared:<group>:<name>` outside the application's group), fn `declared`, `singleflight: true`. The payload holds the parsed timing and the occurrence it runs: `{ name, group?, schedule, retry?, scheduledFor }`. The due time is normally `scheduledFor`, but a late alarm or the memory-limit breaker's backoff moves only the due time, so the occurrence's keys never change under a replay. There is no table of its own and no second record to keep in step.

`declare(source, options)` runs after any earlier call has finished (one promise chain per Scheduler), so an older function source that resolves late cannot undo a newer declaration. Then:

1. Read and parse every entry. A bad name, expression or timezone rejects the call before any write, and the group's last accepted declaration stays active. With none, the rejected one is kept so each occurrence reads it again.
2. For each name, keep a job whose timing and retry are unchanged (re-pushing it in place when the Scheduler's resolved retry defaults changed). Otherwise push the job (same id, so it replaces) at the next occurrence from now.
3. Cancel this group's jobs for names that are gone. Other groups are untouched.
4. Re-arm the alarm, so a lost alarm recovers on the next start.

When a job is due, the Scheduler reads the group's declaration again (the `run` closures only exist in memory), checks the entry still exists with the same timing, and calls `run` in host context. It then pushes the job again for the next occurrence, counted from `scheduledFor` so an interval does not drift and a late alarm does not backfill; that push supersedes the drive result. Failures retry under the job's retry policy; after the last attempt `onError` runs and the next occurrence is still pushed. A job whose group is no longer declared, or whose name left the declaration, is deleted when it comes due. A job whose entry changed timing without a reconcile is re-armed instead of run.

## Guarantees

- Durable: one job per name. In memory: the declaration and `run`.
- At least once per occurrence. The context carries `occurrenceKey` and `idempotencyKey` for the caller's own dedupe.
- One run per name at a time, up to the hung timeout.
- Root only. On a routed Lifecycle (a facet) `declareSchedules()` arms nothing and warns once.
- Groups keep a library's names (Think uses `"think"`) apart from the application's on one Scheduler.

## Key decisions

- **Jobs, not rows.** Think's version kept `cf_think_scheduled_tasks` (hashes, `schedule_id`, `next_run_at`) beside a one-shot Agent schedule and had to repair the states where the two disagreed. With the job as the only record those states do not exist.
- **Retry through the job queue.** The Lifecycle driver already retries, separates platform failures (kept for the next alarm) from application failures, and lets `onJobError` return the next time. Think wrapped the action in its own in-process retry instead.
- **Root only, no opt-in.** Think had `getScheduledTasksScope()` because a facet shares the root's alarm and a static declaration armed once per live facet (#1877). Sub-agents that need their own schedules are their own Durable Objects, so the opt-in is gone.
- **Migration (Scheduler schema version 3).** On start, `cf_think_scheduled_tasks` rows and the root's `_runDeclaredScheduledTask` jobs (its own and its facets') are read, each root task's exact next occurrence (the table's `next_run_at`, else the job payload's `scheduledFor`, never the rounded job time) is kept under `cf_agents:declared_schedules_legacy_next`, the old jobs are deleted and the table dropped. Think's first `declareSchedules()` (group `"think"`) arms each still-declared name at its kept occurrence, so Think's idempotency keys match across the upgrade, then deletes the key. One way.

## Tradeoffs

- Declared schedules are not `Schedule`s: `list()`, `get()` and `cancel()` do not see them. `listDeclaredSchedules(scheduler)` is the read path. Cancelling one means removing it from the declaration.
- A `run` longer than the hung timeout can be taken over by the next alarm and run twice. Same rule as `every()` intervals.
- Changing a task's timing in the same deploy that upgrades from Think's table uses the old next run time once.
