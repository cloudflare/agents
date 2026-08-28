---
"agents": minor
---

Add a Cap'n Web connection transport to the WebSockets capability.

A connection can opt into a second wire (`?__agents_transport=capnweb`):
the same frames travel over a single Cap'n Web RPC session whose root
carries exactly one method — the message pipe. The capability's
handlers are transport-agnostic: both kinds of connection dispatch the
same `onConnect`/`onMessage`/`onClose`, appear in `getConnections()`,
and propagate `connection.close(code, reason)` to the client.

Because `Agent` rides the capability, `useAgent({ transport: "capnweb" })`
works against any Agent with the hook surface unchanged — identity,
state sync, `call`/`stub` RPC frames, and chat all flow over the pipe,
with reconnection and terminal-close semantics matching the PartySocket
path. The pipe client is internal to the hook — there is no new public
client surface.

Cap'n Web transport connections are non-hibernating: the Durable Object
stays pinned in memory while one is open.
