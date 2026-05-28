---
"agents": patch
---

Tighten SSE resumability in `McpAgent`'s streamable HTTP transport.
Follow-up to #1583.

- **Final tool response is now actually replayable.** The previous code
  stored the final response in the event store and immediately called
  `clearStream(streamId)` on `shouldClose`, deleting every event for
  that stream — including the one just written. A client that lost the
  connection mid-flight could reconnect with `Last-Event-ID` and find
  nothing to replay. Fixed by dropping the `clearStream` call: events
  stay in the store until the cleanup alarm sweeps them. The persisted
  `streamId -> requestIds` mapping is still cleared on close so the
  stream is treated as completed for future routing.

- **POST event store writes are unconditional**, matching the
  standalone path. Previously the transport relied on a live WS
  connection at `send()` time to record the event; if the client had
  dropped (common during long tool calls on flaky networks) the event
  was lost. Now the transport falls back to a persisted
  `requestId -> streamId` reverse lookup (`McpAgent.getStreamIdForRequestId`),
  stores the event, and writes to the wire only if a live connection is
  still attached. Reconnecting with `Last-Event-ID` replays anything
  that was missed.

- **Resumed connection registers under the source streamId**, matching
  the SDK reference. For an active POST stream the persisted
  `requestIds` are restored so future tool messages route to the new
  WS. For the standalone listen stream the connection takes over that
  role. For a completed POST the connection serves as a one-shot
  replay channel.

- **Cleanup is alarm-driven and quiescent.** Every `storeEvent` re-arms
  a single idempotent cleanup schedule. When it fires it sweeps streams
  that have been quiet for `maxAgeMs` (default 24h), then either
  reschedules at the next earliest expiry or doesn't reschedule at all.
  Idle `McpAgent` DOs do no periodic work; the next write re-arms.
  Cleanup cost is O(active streams) — the sweep scans only a
  per-stream metadata index, never the event log itself.

- **`DurableObjectEventStore` is exported** so callers embedding
  `WorkerTransport` inside an Agent / Durable Object can wire up
  resumability with `new DurableObjectEventStore(this.ctx.storage)`.
