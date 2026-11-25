---
"agents": patch
---

`agents/streams` and event logs.

- `list()` breaks `created_at` ties by insertion order, `close({ commit })` rejects an `async` `commit`, and `read`/`readBatches` throw `RangeError` for a non-integer `from` or non-finite `batchSize` (#3062).
- Streams takes an optional `name` (experimental) for a separate set of streams in its own tables.
- Event-log frames from a sub-agent's sockets now reach the sub-agent (#3018).
