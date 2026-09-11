---
"agents": minor
---

The `WebSockets` capability speaks the Agent protocol for plain hosts, and
gains a Cap'n Web connection transport.

A plain Durable Object composed with `WebSockets` now works with `useAgent`
and `AgentClient` like an `Agent` does: the capability sends the identity
frame on connect (`identity: false` opts out) and answers `rpc` frames
against `callables`, so `call()` and `stub` reach the host's `RpcTarget`.
The experimental `?__agents_rpc=capnweb` callables endpoint from 0.23.0 is
removed: the same target is reached through `useAgent` on either transport.

Clients can pick the wire with `useAgent({ transport: "capnweb" })` (also on
`AgentClient`). The default `"cf-websocket"` is the hibernating socket and
answers `call()`/`stub` as JSON `rpc` frames. `"capnweb"` carries protocol
frames through one Cap'n Web session whose root also serves `callables`
natively: `call()`/`stub` invoke them directly, an `RpcTarget` result comes
back as a live stub, a `ReadableStream` streams, and calls pipeline. The
Durable Object stays in memory while a capnweb connection is open.
PartySocket keeps owning reconnection and buffering on both — the transport
only swaps the socket class it instantiates. Handlers are wire-agnostic, and
both kinds of connection appear in `getConnections()`. `@callable()`
decorators stay a JSON-wire feature of `Agent`.
