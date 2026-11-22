# Event logs

**Internal.** Not a public API. Nothing new from the slim-hosts work is exposed to apps until it has shipped inside `Think` and `AIChatAgent` for a release and is shown correct ([rfc-slim-hosts.md](./rfc-slim-hosts.md#exposure)). Sibling packages import it from `agents/internal`.

How the WebSockets capability numbers, stores, and replays outbound events. Code: `packages/agents/src/websockets/event-log.ts`, `event-log-protocol.ts`, `packages/agents/src/event-log-client.ts`.

## How it works

`declareEventLog(webSockets, name, options)` returns an `EventLog`. Each event gets the log's next `seq` (from 1, only growing), is stored in SQLite, and goes to the connections following the log. A client follows with a subscribe frame carrying its cursor, `{ epoch, seq }`, the last event it applied. The server answers in one synchronous block, so no publish can land between replay and live:

- it replays every retained event after the cursor, then sends `synced`, or
- it sends `resync` with the host's snapshot and the head `seq`, when the cursor is absent, from another epoch, ahead of the head, before the oldest retained event, or in a hole a crash left.

Then it records the subscription in the connection's hibernation attachment (`_cf_logs`), so a hibernated socket still gets events after a wake. Connection state that is not a plain object (an array, a string) is kept under `_cf_value` beside the flags and keeps its shape. The client re-subscribes with its cursor on every reconnect.

### Frames

| Direction | `type`                     | Fields                             |
| --------- | -------------------------- | ---------------------------------- |
| client    | `cf_agent_log_subscribe`   | `log`, `cursor?`, `id?`            |
| client    | `cf_agent_log_unsubscribe` | `log`                              |
| server    | `cf_agent_log_events`      | `log`, `events: [{seq, data}]`     |
| server    | `cf_agent_log_synced`      | `log`, `epoch`, `seq`              |
| server    | `cf_agent_log_resync`      | `log`, `epoch`, `seq`, `snapshot?` |
| server    | `cf_agent_log_error`       | `log`, `error`                     |

A live event is a one-element `events` frame with no `id`, for every follower. A replay sends frames of up to 100 events. The frames that answer a subscribe (replay `events`, `synced`, `resync`, `error`) echo its `id`, so several followers of one log on one socket each apply only their own answer; the client counts them and unsubscribes only when the last one closes.

### Storage: a stream

The log stores nothing of its own. It is one stream, `log:<name>`, of the host's `Streams` capability (`options.streams`). Event seq n is chunk n - 1 of that stream, and the stream's metadata holds the log's epoch, a random id written once. A client cursor from before a storage wipe or a `reset()` never matches a new log that happens to reach the same seq. An event can be at most `maxEventBytes` (1 MiB by default, 1.9 MB at most).

A buffered write goes into a new block: one INSERT per flush, no read, and no rewrite of an earlier block (an UPDATE that grew a 256 KB block cost 160-480 ms of CPU per 2,000 publishes on a deployment). The open block of a buffered stream is kept in memory after the first read. An event is serialized once: the live frame and the stored chunk are the same text.

Retention (`Streams.trim`) deletes the oldest blocks while the log holds more than `maxEvents` events or `maxBytes` stored bytes (UTF-8, as SQLite counts them), and never the newest block. A block is one flush, so a log can hold up to one flush more than its limits, and the head is never reused. Totals are read once per isolate and kept in memory.

### Batches and the crash rule

`publish` writes before it sends. `batch().append` sends first and writes later. The chunk waits in Streams' buffer for the stream until 10 events, 256 KiB, 250 ms (the log's timer), a `publish` on the same log, `flush()`, `close()`, or a subscribe (which writes the buffer and applies retention before it judges the cursor, so the replay reads exactly what was judged). One buffer per stream keeps seq order across batches and publishes.

A crash loses what is buffered, at most `maxEvents - 1` events and at most `maxDelayMs`. The rule that keeps a lost seq from being reused costs one early write per isolate: in each isolate, the first buffered append to a stream that the isolate did not create starts `maxEvents` seqs past the stored head and is written at once, so the skip is durable before anything after it can be lost. Seqs a crash may have lost are never given to a new event, and they stay a hole between blocks. A cursor in a hole (`Streams.holds` is false for it) saw a lost event and resyncs. A cursor before the hole replays across it: it never saw the lost events, and neither did storage. A cursor of 0 replays only while the log still holds its first chunk.

`ctx.abort()` and resets close every hibernatable socket (RUNTIME-FACTS.md), and an eviction waits for the batch timer, so a socket that saw lost events reconnects and learns it from its cursor. A code update keeps sockets open: such a socket sees the next live event's seq jump, and the client's skip guard asks again from its cursor, which resyncs. Until that subscribe is answered the client ignores live frames, because the replay sends them again in order.

An `onEvent` that throws is reported with `reportError` where the runtime has it (browsers and workerd: error listeners see it), and logged elsewhere (Node has none, and a rethrow would end the process); the client goes on with the next event, with the cursor past the one that threw. Stopping instead would lose events: the replay path does not check for gaps, so an event left behind in a replay frame would never come again. Re-delivering the event that threw would loop on a handler that always throws.

## Guarantees

- **Durable:** every `publish` before its frame leaves; batched events at their write; the epoch; trimming; which logs each connection follows.
- **In memory, lost in a crash:** a batch's unwritten events (at most `maxEvents - 1`, at most `maxDelayMs` old); the cached open block and totals (read again on first use).
- **Client memory:** the cursor and the state built on it. A page reload starts with a resync.
- **Delivery:** in `seq` order, at least once across reconnects. No per-client cursor or acknowledgement on the server. The client drops events at or before its cursor.
- **Snapshot:** `snapshot(connection)` runs in the same synchronous block that reads the head, so the snapshot and the resync's `seq` agree, provided the producer changes the state and publishes in one synchronous block.

## Key decisions

- **A Streams stream, not tables of its own** (one-log). Its first version had two tables with their own batching, trimming, epoch and crash gap. Streams now has buffered appends, head trim and the crash hole, so one chunk store serves both, and a later chat log can be a view over a turn's stream without writing a chunk twice.
- **A hole, not a gap row.** The first version marked every row written while a batch was open (`open_until`) and wrote a gap row on the next start. The hole needs neither: the next isolate skips `maxEvents` seqs, and a cursor in a hole resyncs.
- **Cap, not split.** An event larger than one row is refused before it gets a `seq`. Splitting would let a reader see half an event and makes replay reassemble rows. Producers with huge values cut them at their own level (chat already truncates tool outputs for persistence).
- **Subscriptions are frames, not URL parameters.** A connection follows several logs and can start or stop following without reconnecting.
- **The client resyncs on the first subscription.** A client with no state has nothing to apply events to, so it always starts from the snapshot.
- **A synchronous snapshot.** An async snapshot would let events land between the snapshot and the head, and the client would apply some twice. Durable Object SQLite reads are synchronous, so the restriction costs nothing for state the object holds.

## Tradeoffs

- Every live event reads each connection's attachment to check its subscriptions. Cheap for a handful of connections per object; a cache would help an object with hundreds.
- A crashed batch costs clients that saw its tail a full resync, even when nothing was in fact lost.
- Retention deletes whole rows, so a log can hold up to one row more than its limits.
- Retention runs only for declared logs. Rows of a log a deploy stopped declaring stay in the tables until something deletes them.
- The followed log names live in the connection's hibernation attachment beside user state, which the runtime caps at 2 KB. Keep log names short; a connection following many long-named logs can overflow it.

## Inspiration

The [durability](https://durability.shirei.dev/) socket primitive: outbound events stored with a sequence before they are pushed, cursor replay or snapshot resync, and no per-client acknowledgements. The batching, the epoch and the crash gap are ours.
