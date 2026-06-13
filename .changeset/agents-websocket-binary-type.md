---
"agents": patch
---

Pin accepted WebSocket connections to `binaryType = "arraybuffer"`. On Worker
`compatibility_date`s `>= 2026-03-17` the runtime defaults a server WebSocket's
`binaryType` to `"blob"` (the `websocket_standard_binary_type` flag), so binary
frames arrive as `Blob` instead of `ArrayBuffer`. The Agent protocol and every
downstream consumer (e.g. `@cloudflare/voice` audio frames, user `onMessage`
handlers that check `message instanceof ArrayBuffer`) have always relied on
`ArrayBuffer`. The Agent now sets `connection.binaryType = "arraybuffer"` when a
connection is established, restoring the historical contract regardless of
compatibility date without requiring the `no_websocket_standard_binary_type`
flag. (The hibernatable `webSocketMessage` handler always delivers
`ArrayBuffer`, so this only affects non-hibernating agents.)

Also bumps the `partyserver` dependency to `^0.5.7`, which pins `binaryType` at
the connection layer (`accept()`), accepts non-hibernating connections in
half-open mode, and suppresses retryable transport-teardown errors on
already-closing/closed connections. With partyserver now pinning `binaryType`
itself, the Agent's own pin becomes defense-in-depth (kept for older partyserver
versions and custom connections) and runs once per connection per isolate
lifetime instead of on every state access.
