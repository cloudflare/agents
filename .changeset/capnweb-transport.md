---
"agents": minor
---

`WebSockets` speaks the Agent protocol for plain hosts, and gains a Cap'n Web transport.

- A plain Durable Object composed with `WebSockets` now works with `useAgent` and `AgentClient`: the capability sends the identity frame on connect (`protocol: false` leaves the connect sequence to the host) and serves `callables` — an `RpcTarget` whose prototype methods are the host's remote interface.
- `useAgent({ transport })` and `AgentClient({ transport })` pick the wire. `"cf-websocket"` (default) is the hibernating socket; `call()`/`stub` send JSON `rpc` frames. `"capnweb"` runs one Cap'n Web session that carries protocol frames and serves `callables` natively: `call()`/`stub` invoke them directly, an `RpcTarget` result is a live stub, a `ReadableStream` streams, calls pipeline. The Durable Object stays in memory while a capnweb connection is open. PartySocket still owns reconnection on both.
- `@callable()` decorators remain the JSON-wire interface of `Agent`; an Agent wanting native calls passes `callables`.
- The experimental `?__agents_rpc=capnweb` endpoint from 0.23.0 is removed.
- `LifecycleServices` exposes `name` and `className`.
