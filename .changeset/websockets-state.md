---
"agents": minor
---

The `WebSockets` capability now owns the Agent protocol's state sync and per-connection flags, for `Agent` and plain hosts alike.

- `state` takes a `State` capability. The current value is pushed to each new connection after identity, a client's `cf_agent_state` frame goes through the host's `validateStateChange` (a readonly connection is refused, a rejected change gets a generic `cf_agent_state_error`), and `broadcastState(source)` pushes a change to every protocol-enabled connection but its source — wire it to the `State`'s `onChanged`. So `useAgent().state` and `setState()` work against a plain Durable Object.
- `protocol` and `readonly` are per-connection policies decided at accept time; `sendIdentity()`, `sendState()`, `applyStateFrame()`, `isReadonly()`/`setReadonly()`, and `isProtocolEnabled()`/`setProtocolEnabled()` are the capability's surface for hosts that drive the sequence themselves. The `identity` option from the previous changeset is replaced by `protocol`.
- The readonly and no-protocol flags, their `_cf_` storage in connection state, and the wrapper that hides them from `connection.state` move out of `Agent` into `agents/websockets` (`registerInternalConnectionKeys` for a host's own keys). `Agent`'s public methods and wire behaviour are unchanged; it passes `protocol: false` and drives its connect sequence through the capability after its facet routing decision.
