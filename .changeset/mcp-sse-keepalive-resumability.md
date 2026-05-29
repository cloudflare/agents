---
"agents": patch
---

Fix SSE keepalive and enable resumability on the MCP transports (#1583).

The MCP transports had a defective SSE keepalive (`event: ping\ndata: \n\n`
— a named event the SSE parser dispatched with empty data, firing
`addEventListener("ping", …)` on the client) and no recovery path for the
~5 min Cloudflare edge idle-stream watchdog. This change makes
resumability the first-class recovery mechanism while keeping the
keepalive available when resumability isn't configured.

- **GET (standalone listen stream)** — when an `EventStore` is configured,
  no keepalive; idle drops are recovered by clients reconnecting with
  `Last-Event-ID`. Without an `EventStore`, the comment-frame keepalive
  (`: keepalive\n\n` every 25s) keeps long-lived listeners alive.
- **POST (tool response stream)** — always keepalive. In-flight tool
  calls survive the ~5 min idle watchdog. POST streams can additionally
  be resumed via `Last-Event-ID` when an `EventStore` is configured: a
  reconnecting GET inherits the original POST's `requestIds` so
  subsequent tool messages route to the resumed connection.
- **Storage bounds** — `DurableObjectEventStore` now wraps each event
  with a write timestamp and exposes `sweep(maxAgeMs)`. `McpAgent`
  schedules a recurring sweep (default hourly, 24 hr TTL) so events from
  abandoned POST streams whose clients never returned don't accumulate
  forever in Durable Object storage. Streams that close cleanly are
  cleared in full on the final response.

Also fixed: a pre-existing bug where an `McpAgent` GET stream that
reconnected with `Last-Event-ID` received the replayed backlog but
wasn't re-tagged as the standalone SSE stream, so subsequent
server-initiated notifications had no connection to land on.

All changes are additive — patch-level, no breaking changes.
`DurableObjectEventStore` is exported from `agents/mcp` for stateful
`WorkerTransport` callers (e.g. the elicitation example, which now
wires resumability via `eventStore: new DurableObjectEventStore(this.ctx.storage)`).
