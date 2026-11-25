---
"agents": patch
---

`agents/streams` and event logs.

- `list()` breaks `created_at` ties by insertion order, `close({ commit })` rejects an `async` `commit`, and `read`/`readBatches` throw `RangeError` for a non-integer `from` or non-finite `batchSize` (#3062).
- Streams takes an optional `name` (experimental) for a separate set of streams in its own tables.
- Event-log frames from a sub-agent's sockets now reach the sub-agent (#3018).
- `ResumableStream` is no longer exported from `agents/chat`. `AIChatAgent` and `Think` keep their in-flight output in Streams as before, through an internal log. `@cloudflare/ai-chat` 0.12.x and earlier and `@cloudflare/think` 0.24.x and earlier construct it, so upgrade them together with `agents`.
