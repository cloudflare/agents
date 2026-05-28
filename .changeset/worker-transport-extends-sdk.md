---
"agents": minor
---

Refactor `WorkerTransport` to extend the official MCP SDK's `WebStandardStreamableHTTPServerTransport` instead of being a hand-rolled implementation.

The wrapper is now a thin subclass that layers Workers-specific concerns on top of the SDK transport:

- **CORS** — preflight handling and response-header injection (`corsOptions`).
- **Persistent transport state** across DO hibernation via the existing `MCPStorageApi` adapter. `sessionId`, `initialized`, and `initializeParams` are snapshotted after each request and replayed on cold start so client capabilities are restored without a fresh initialize round-trip.
- **SSE keepalive** — preserves the issue #1583 fix. Uses the shared `KEEPALIVE_FRAME` (`: keepalive\n\n`) at `KEEPALIVE_INTERVAL_MS` (25s) from `sse-keepalive.ts`. Keepalive is unconditional on POST response streams and disabled on the standalone GET stream when an `eventStore` is configured (clients recover idle drops via `Last-Event-ID` instead).

Everything else — session validation, SSE streaming, protocol-version negotiation, event-store resumability, send/close lifecycle — is delegated to the SDK transport. Net: ~500 fewer lines of code to maintain.

Public API is unchanged: `WorkerTransport`, `WorkerTransportOptions`, `MCPStorageApi`, and `TransportState` keep the same exported shape, so downstream callers (`createMcpHandler`, `McpAgent`, examples, third-party users) work without changes.
