# Event logs

How the WebSockets capability numbers, stores, and replays outbound events. User docs: [docs/agents/event-logs.md](../docs/agents/event-logs.md). Code: `packages/agents/src/websockets/event-log.ts`, `event-log-protocol.ts`, `packages/agents/src/event-log-client.ts`.

## How it works

`WebSockets.log(name, options)` returns an `EventLog`. Each event gets the log's next `seq` (from 1, only growing), is stored in SQLite, and goes to the connections following the log. A client follows with a subscribe frame carrying its cursor, `{ epoch, seq }`, the last event it applied. The server answers in one synchronous block, so no publish can land between replay and live:

- it replays every retained event after the cursor, then sends `synced`, or
- it sends `resync` with the host's snapshot and the head `seq`, when the cursor is absent, from another epoch, ahead of the head, before the oldest retained event, or inside a gap.

Then it records the subscription in the connection's hibernation attachment (`_cf_logs`), so a hibernated socket still gets events after a wake. The client re-subscribes with its cursor on every reconnect.

### Frames

| Direction | `type`                     | Fields                             |
| --------- | -------------------------- | ---------------------------------- |
| client    | `cf_agent_log_subscribe`   | `log`, `cursor?`                   |
| client    | `cf_agent_log_unsubscribe` | `log`                              |
| server    | `cf_agent_log_events`      | `log`, `events: [{seq, data}]`     |
| server    | `cf_agent_log_synced`      | `log`, `epoch`, `seq`              |
| server    | `cf_agent_log_resync`      | `log`, `epoch`, `seq`, `snapshot?` |
| server    | `cf_agent_log_error`       | `log`, `error`                     |

A live event is a one-element `events` frame. A replay sends one frame per stored row.

### Storage

Two tables, created on first use:

- `cf_agents_event_logs (log, epoch, created_at)`: one row per log. The epoch is a random id written once, so a client cursor from before a storage wipe never matches a new log that happens to reach the same `seq`.
- `cf_agents_event_log_rows (log, seq_from, seq_to, kind, body, bytes, open_until, created_at)`, keyed by `(log, seq_from)`: each row holds a contiguous run of whole events (`kind = 'events'`, `body` a JSON array of `{seq, data}`), or marks seqs a crash lost (`kind = 'gap'`). Rows cover the log's seqs without holes.

A row closes before its body passes 512 KB. An event can be at most `maxEventBytes` (1 MiB by default, 1.9 MB at most), so every row fits SQLite's 2 MB limit. Counts, bytes, the oldest seq and the head are read with one aggregate query per isolate and kept in memory after that.

Retention deletes the oldest rows while the log holds more than `maxEvents` events or `maxBytes` bytes, and never deletes the newest row. The head is always `max(seq_to)`, so trimming never frees a seq for reuse.

### Batches and the crash gap

`publish` writes before it sends. `batch().append` sends first and writes later: it buffers until 10 events, 256 KiB, 250 ms, a `publish` on the same log, `flush()` or `close()`. One buffer per log keeps seq order across batches and publishes.

A batch's first `append` is written at once. While any batch is open, every written row carries `open_until = seq_to + maxEvents`; the write on the last `close()` clears it (an UPDATE of the newest row when nothing was buffered). A batch holds at most `maxEvents - 1` unwritten events, so the seqs a crash can lose all lie in `[seq_to + 1, open_until)`.

When a log is first touched in an isolate and its newest row has `open_until`, the previous isolate ended with a batch open. The log writes a gap row `[seq_to + 1, open_until]` and moves the head to `open_until`. The gap ends one past the last seq that can have been lost, so no client cursor can equal its last seq; once retention trims the gap, a cursor just before the oldest kept event is still one that saw nothing lost. The log then sends `resync` to every connection that still follows it (hibernated sockets survive an eviction).

A client that saw a lost event has a cursor inside the gap and gets `resync`. A client whose cursor is before the gap replays across it: it never saw the lost events, and neither did storage.

The client also re-subscribes if a live event skips a seq, letting the server choose between replay and resync. With the server-side gap resync this should not happen; it is a cheap guard.

## Guarantees

- **Durable:** every `publish` before its frame leaves; batched events at their write; the epoch; trimming; which logs each connection follows.
- **In memory, lost in a crash:** a batch's unwritten events (at most `maxEvents - 1`, at most `maxDelayMs` old); the cached counts (rebuilt with one query).
- **Client memory:** the cursor and the state built on it. A page reload starts with a resync.
- **Delivery:** in `seq` order, at least once across reconnects. No per-client cursor or acknowledgement on the server. The client drops events at or before its cursor.
- **Snapshot:** `snapshot(connection)` runs in the same synchronous block that reads the head, so the snapshot and the resync's `seq` agree.

## Key decisions

- **Own tables, not Streams.** Streams holds finite streams that settle and are deleted whole, with no head trimming. A log is one unbounded sequence trimmed from the front, read by many clients at different cursors. Sharing the block table would mean bending both.
- **Cap, not split.** An event larger than one row is refused before it gets a `seq`. Splitting would let a reader see half an event and makes replay reassemble rows. Producers with huge values cut them at their own level (chat already truncates tool outputs for persistence).
- **Subscriptions are frames, not URL parameters.** A connection follows several logs and can start or stop following without reconnecting.
- **The client resyncs on the first subscription.** A client with no state has nothing to apply events to, so it always starts from the snapshot.
- **A synchronous snapshot.** An async snapshot would let events land between the snapshot and the head, and the client would apply some twice. Durable Object SQLite reads are synchronous, so the restriction costs nothing for state the object holds.

## Tradeoffs

- Every live event reads each connection's attachment to check its subscriptions. Cheap for a handful of connections per object; a cache would help an object with hundreds.
- A crashed batch costs clients that saw its tail a full resync, even when nothing was in fact lost.
- Retention deletes whole rows, so a log can hold up to one row more than its limits.

## Inspiration

The [durability](https://durability.shirei.dev/) socket primitive: outbound events stored with a sequence before they are pushed, cursor replay or snapshot resync, and no per-client acknowledgements. The batching, the epoch and the crash gap are ours.
