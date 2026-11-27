---
"agents": minor
---

Experimental `agents/tasks` API changes. See [Tasks](https://github.com/cloudflare/agents/blob/main/docs/agents/tasks.md#inspection-and-control).

- Snapshots and receipts carry `status` (was `state`), `TaskRunState` is now `TaskStatus`, `failed` is now `error`, `cancelled` is now `aborted`, and `waiting` is now `pending` with `waitReason` and `wakeAt`; stored runs are migrated.
- `cancel()` settles a run `aborted` at once, and `tasks.run()` throws `TaskInputConflictError` when a reused `runId` or `idempotencyKey` has a different input.
- Tasks takes an optional `name` for more than one Tasks per object.
- A run is recovered within seconds of a reset, or 30 seconds after a transient platform failure (#3066).
