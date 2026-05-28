---
"agents": patch
---

Fix SSE keepalive and enable resumability on the MCP transports (#1583).

The MCP transports had a defective SSE keepalive (`event: ping\ndata: \n\n`
— a named event the SSE parser dispatched with empty data, firing
`addEventListener("ping", …)` on the client) and no recovery path for the
~5 min Cloudflare edge idle-stream watchdog. This change splits keepalive
and resumability by stream direction:

- **GET (standalone listen stream)** — never keepalive. Idle drops are
  recovered by clients reconnecting with `Last-Event-ID` against a
  configured `EventStore`. `McpAgent` now defaults to a
  `DurableObjectEventStore` backed by its own storage; `WorkerTransport`
  callers wire their own (e.g. `new DurableObjectEventStore(this.ctx.storage)`
  when embedding it in an Agent).
- **POST (tool response stream)** — always keepalive. POST streams are
  scoped to a single request id and cannot be resumed, so they emit a
  `: keepalive\n\n` comment frame every 25s so long-running tool calls
  survive the idle watchdog. The comment form is dropped by the SSE
  parser before any event dispatch.

Also: fixed a pre-existing bug where a `McpAgent` GET stream that
reconnected with `Last-Event-ID` received the replayed backlog but
wasn't re-tagged as the standalone SSE stream, so subsequent
server-initiated notifications had no connection to land on.

All changes are additive — patch-level, no breaking changes. The new
`DurableObjectEventStore` is exported from `agents/mcp`.
