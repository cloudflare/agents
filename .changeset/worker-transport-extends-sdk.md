---
"agents": minor
---

Refactor `WorkerTransport` to extend the official MCP SDK's `WebStandardStreamableHTTPServerTransport` instead of being a hand-rolled implementation.

The wrapper is now a thin subclass that layers Workers-specific concerns on top of the SDK transport:

- **CORS** — preflight handling and response-header injection (`corsOptions`).
- **Persistent transport state** across DO hibernation via the existing `MCPStorageApi` adapter. `sessionId`, `initialized`, and `initializeParams` are snapshotted after each request and replayed on cold start so client capabilities are restored without a fresh initialize round-trip.
- **SSE keepalive** — preserves the issue #1583 fix. Uses the shared `KEEPALIVE_FRAME` (`: keepalive\n\n`) at `KEEPALIVE_INTERVAL_MS` (25s) from `sse-keepalive.ts`. Keepalive is unconditional on POST response streams and disabled on the standalone GET stream when an `eventStore` is configured (clients recover idle drops via `Last-Event-ID` instead).

Everything else — session validation, SSE streaming, protocol-version negotiation, event-store resumability, send/close lifecycle — is delegated to the SDK transport. Net: ~500 fewer lines of code to maintain.

The exported shape is unchanged: `WorkerTransport`, `WorkerTransportOptions`, `MCPStorageApi`, and `TransportState` keep the same names, and `WorkerTransportOptions` now also extends the SDK's transport options. The default `createMcpHandler` path (a fresh transport per request) is unaffected.

There are, however, a few observable behaviour changes for callers who used `WorkerTransport` directly or relied on its previous quirks:

- **`handleRequest`'s second argument is now `{ parsedBody?, authInfo? }`** (the SDK shape) instead of a positional `parsedBody`. `createMcpHandler` and `McpAgent` don't pass it, but callers invoking `transport.handleRequest(request, parsedBody)` directly must wrap it as `transport.handleRequest(request, { parsedBody })`.
- **`retryInterval` priming now follows the SDK contract.** Previously a `retry:` priming frame was written to _any_ GET SSE stream whenever `retryInterval` was set. The SDK only writes a priming event when an `eventStore` is configured and the negotiated protocol version is `>= 2025-11-25` (older clients can't parse the empty-`data:` priming frame), and on POST streams rather than the standalone GET stream. `retryInterval` is still accepted but only affects that SDK priming event.
- **`onerror` now fires on client/protocol validation failures.** The SDK invokes `onerror` for responses such as 400/405/406/415 and session-not-found. The old transport only surfaced internal errors, so handlers that log `onerror` will now see normal client mistakes.
- **`onsessionclosed` fires before the underlying `close()`** (and therefore before `onclose`) on DELETE, instead of after. Ordering only; the session id is still passed.
- **`started` is now read-only.** It was a writable instance field and is now a getter backed by the SDK's internal `_started` flag. Reading it (e.g. `createMcpHandler`'s reconnect guard) is unchanged; assigning to it is no longer supported.
- **`createMcpHandler` now forwards SDK transport options.** Because `WorkerTransportOptions` extends the SDK options, the handler passes through everything except its own `route`/`authContext`/`transport` fields — including `eventStore`, `retryInterval`, `onsessionclosed`, and the SDK DNS-rebinding options (`enableDnsRebindingProtection`, `allowedHosts`, `allowedOrigins`). The previous handler silently dropped these.

The SDK dependency is pinned exactly (`@modelcontextprotocol/sdk` `1.29.0`, no caret) because the wrapper relies on a handful of SDK internals for state restore and keepalive cleanup. The exact pin stops a patch release from shifting those out from under us, and the tests assert against the SDK field names so a bump fails CI loudly rather than breaking at runtime.
