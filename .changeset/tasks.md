---
"agents": minor
---

Experimental `agents/tasks` API changes. See [Tasks](https://github.com/cloudflare/agents/blob/main/docs/agents/tasks.md#inspection-and-control).

- Snapshots and receipts carry `status` (was `state`), `TaskRunState` is now `TaskStatus`, `failed` is now `error`, `cancelled` is now `aborted`, and `waiting` is now `pending` with `waitReason` and `wakeAt`; stored runs are migrated.
- `cancel()` now settles a run `aborted` at once, and nothing a cancelled attempt writes afterwards lands.
- `tasks.run()` throws `TaskInputConflictError` when a reused `runId` or `idempotencyKey` comes with a different input, instead of returning the earlier run.
- Tasks takes an optional `name` for more than one Tasks per object. See [More than one Tasks](https://developers.cloudflare.com/agents/api-reference/tasks/#more-than-one-tasks).
- A run that outlives its alarm is recovered within seconds of a reset instead of after 30 seconds (#3066).
- A run whose attempt hits a transient platform failure (a storage reset, a lost connection) runs again after 30 seconds, instead of only when its claim runs out several minutes later.
