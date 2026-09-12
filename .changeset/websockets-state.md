---
"agents": minor
---

`WebSockets` syncs a `State` capability over connections, so `useAgent().state` and `setState()` work against a plain Durable Object.

```ts
readonly state = new State({ initialState: { count: 0 } });
readonly webSockets = new WebSockets({ state: this.state });
readonly lifecycle = Lifecycle.install(this).use(this.state).use(this.webSockets);
```

The current value is pushed to each new connection after the identity frame, a client's `cf_agent_state` frame is validated by the host's `validateStateChange` and applied (a rejected one is answered with `cf_agent_state_error`), and every change is broadcast to the other connections. `broadcastState()` pushes a host-side change. Works on both transports. Without the option, state is never sent or accepted over connections.
