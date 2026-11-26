---
"agents": patch
---

`agents/streams` and event logs.

- `list()` breaks `created_at` ties by insertion order, `close({ commit })` rejects an `async` `commit`, and `read`/`readBatches` throw `RangeError` for a non-integer `from` or non-finite `batchSize` (#3062).
- Streams takes an optional `name` (experimental) for a separate set of streams in its own tables.
- Event-log frames from a sub-agent's sockets now reach the sub-agent (#3018).
- `ResumableStream` from `agents/chat` is deprecated: `AIChatAgent` and `Think` no longer use it, and it stays only for `@cloudflare/ai-chat` 0.12.x and `@cloudflare/think` 0.24.x, which construct it. Upgrade them together with `agents`.
