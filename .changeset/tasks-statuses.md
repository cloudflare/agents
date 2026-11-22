---
"agents": minor
---

Experimental `agents/tasks` API changed: snapshots and receipts carry `status` (was `state`), `TaskRunState` is now `TaskStatus`, `failed` is now `error`, `cancelled` is now `aborted`, and `waiting` is now `pending` with `waitReason` and `wakeAt`; stored runs are migrated. See [Tasks](https://github.com/cloudflare/agents/blob/main/docs/agents/tasks.md#inspection-and-control).
