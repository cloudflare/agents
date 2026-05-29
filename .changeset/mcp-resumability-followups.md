---
"agents": patch
---

Tighten SSE resumability in `McpAgent`'s streamable HTTP transport.
Follow-up to #1583.

- **Final tool response is now actually replayable.** The previous code
  stored the final response in the event store and then immediately
  called `clearStream(streamId)` on `shouldClose`, deleting every event
  for that stream — including the one just written. A client that lost
  the connection mid-flight could reconnect with `Last-Event-ID` and
  find nothing to replay. Fixed by flipping the order: write the SSE
  event to the wire **first**, then drop the persisted
  `streamId -> requestIds` mapping and clear the stored events. Every
  event up to and including the final response is replayable while the
  in-flight stream is open; the trade-off is that if the WS pipe is
  enqueued but the client TCP dies before the bytes arrive, that one
  final message is lost.

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
  WS, and any prior connection that still claimed those `requestIds`
  has them stripped to prevent stale POST bridges from winning the
  routing race against the resumed GET. For the standalone listen
  stream the connection takes over that role. For a completed POST the
  connection serves as a one-shot replay channel.

- **Cleanup is immediate, not background.** Each POST stream's events
  are cleared the moment the close frame is written. No alarms, no
  metadata index, no sweep. Storage cost is bounded by the in-flight
  POST streams plus the standalone GET stream. Multi-key deletes are
  chunked at the Durable Object 128-key limit, and `replayEventsAfter`
  uses an explicit `limit` so a pathological history can't OOM the DO.

- **Standalone notifications fan out to every standalone GET**, matching
  the spec's allowance for multiple concurrent SSE streams per session
  instead of the previous last-writer-wins behaviour.

- **`DurableObjectEventStore` is exported** so callers embedding
  `WorkerTransport` inside an Agent / Durable Object can wire up
  resumability with `new DurableObjectEventStore(this.ctx.storage)`.
