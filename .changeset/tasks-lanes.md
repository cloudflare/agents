---
"agents": minor
---

Experimental `agents/tasks` API changed: `cancel()` now settles a run `aborted` at once (a live attempt's signal aborts and nothing it writes afterwards lands) and a cancel requested during an attempt wins over its result. See [Tasks](https://github.com/cloudflare/agents/blob/main/docs/agents/tasks.md#inspection-and-control).
