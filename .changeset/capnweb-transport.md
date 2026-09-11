---
"agents": minor
---

The `WebSockets` capability speaks the Agent protocol for plain hosts, and
gains a Cap'n Web connection transport.

A plain Durable Object composed with `WebSockets` now works with `useAgent`
and `AgentClient` like an `Agent` does: the capability sends the identity
frame on connect (`identity: false` opts out) and answers `rpc` frames
against `callables`, so `call()` and `stub` reach the host's `RpcTarget`.
The same target is still served natively at `?__agents_rpc=capnweb`.

Clients can pick the wire with `useAgent({ transport: "capnweb" })` (also on
`AgentClient`). The default `"websocket"` is the hibernating socket;
`"capnweb"` carries the same frames over one Cap'n Web RPC session, and the
Durable Object stays in memory while such a connection is open. PartySocket
keeps owning reconnection and buffering on both — the transport only swaps
the socket class it instantiates. Handlers are wire-agnostic, and both kinds
of connection appear in `getConnections()`.
