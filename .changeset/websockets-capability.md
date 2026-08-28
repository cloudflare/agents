---
"agents": minor
---

Move WebSockets out of Lifecycle into the opt-in `WebSockets`
capability, with callables served from an `RpcTarget`.

Lifecycle no longer models WebSockets — many hosts never use sockets.
Hosts that want connections install the capability, which owns the
subsystem end to end:

```ts
new WebSockets({
  handlers: { onConnect, onMessage, onClose },
  callables: new RoomCallables()
});
```

The capability claims WebSocket upgrades, accepts hibernating sockets,
dispatches handlers inside the host invocation boundary, reciprocates
close handshakes, closes owned connections on host destruction, and
answers `getConnections()`/`getConnection()`. Without it installed,
upgrades are declined.

`callables` exposes an `RpcTarget`'s prototype methods to remote
callers over a Cap'n Web session (`?__agents_rpc=capnweb`), with native
`ReadableStream` streaming. `Agent` adds no new surface for this: its
`@callable()`-decorated methods are its interface, served on every wire
— natively over the legacy JSON RPC protocol and, through the
decorator-derived target, over the Cap'n Web endpoint. There is no
separate browser client either: `useAgent().stub`/`call` reach the
same interface, and a plain host's endpoint is one
`newWebSocketRpcSession(new WebSocket(callablesRpcUrl(url)))` away.

`Agent` installs the capability itself, so its `onConnect`/`onMessage`/
`onClose`/`onError`/`getConnectionTags` overrides and connection APIs
behave exactly as before (same wire, same hibernation attachment
format). The Lifecycle host contract drops the WebSocket hooks and
Lifecycle's `getConnections`/`getConnection`/`broadcast` are removed.

Lifecycle keeps only generic platform pass-throughs —
`onWebSocketUpgrade` plus `onWebSocketMessage`/`Close`/`Error` for
capability-owned hibernation wakes — and `LifecycleServices` gains a
narrow `sockets` surface (accept/get) and a connection/request scope on
`runInHostContext`. The capability interaction contract (three
channels: hooks, services, composition-root apertures) is now
documented on `DurableObjectCapability`.
