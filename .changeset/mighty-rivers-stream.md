---
"agents": patch
---

Add `agents/streams`: durable incremental output as a Lifecycle capability (experimental).

One `Streams` instance per Durable Object owns an ordered, durable chunk log per stream with a monotonic cursor: `open()` (idempotent on the id), synchronous durable `append()` that wakes live readers, `close()`/`error()` settlement, replay-then-tail `read({ from, signal })` plus its batched form `readBatches({ from, signal, batchSize, onUpToDate })` (arrays per replay slice and per live-tail wakeup, with a caught-up-to-tail signal), indexed non-unique `tag`s for find-the-latest-stream-of-an-operation lookups (`open(id, { tag })` / `list({ tag })`), `sseResponse()` for one-call SSE serving with native `Last-Event-ID` resume and `up-to-date`/`done`/`error` control events, and `status()` reporting state, cursor, and last activity. Reads are independent of producer liveness; the capability needs no alarm, so it also works on facets.

Streams is the incremental-output half of the pattern the Tasks migration validated, composed without coupling: a task step appends to a stream and checkpoints `{ streamId, cursor }`, and its `recover` callback reads `streams.status()` as durable interruption evidence — proven across a real SIGKILL by the e2e suite, where recovery finalizes the stream at exactly the chunks that survived. Design record: `design/rfc-streams.md`.
