---
"agents": patch
---

`useAgent` and `AgentClient` now resolve `ready` (and set `identified`) only once an agent's stored state has arrived, so code that awaits `ready` no longer reads `state` as `undefined`, and React no longer renders one frame connected with the default state (#2268).

The identity frame carries `stateFollows: true` when a state frame comes next. Clients that do not know the flag ignore it, and older servers never send it, so either side can be upgraded first. A new `sendConnectFrames(connection, identity?)` on the `WebSockets` capability sends the pair; hosts that drive the connect sequence themselves (`protocol: false`) should use it instead of `sendIdentity()` followed by `sendState()`.
