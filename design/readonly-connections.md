# Readonly Connections

This document describes the design of the readonly connections feature: what it does, the key decisions made, alternatives we considered, and known limitations.

## Problem

Agents are collaborative — multiple WebSocket clients connect to the same agent instance and share state. But not every client should be allowed to modify that state. A dashboard viewer shouldn't be able to change settings. A spectator in a game shouldn't be able to move pieces. A free-tier user shouldn't be able to trigger expensive mutations.

We need a way to mark certain connections as "readonly" and enforce that restriction at the framework level, not in userland.

## Design goals

1. **Declarative** — developers declare _which_ connections are readonly, not _how_ enforcement works
2. **Enforcement at the framework boundary** — readonly checks happen inside `setState()`, so they can't be bypassed by forgetting a check in a callable
3. **No boilerplate** — no manual permission checks needed in every `@callable()` method
4. **Survives hibernation** — readonly status persists when the Durable Object goes to sleep and wakes up
5. **Invisible to user code** — the internal flag can't be accidentally read, overwritten, or leaked through `connection.state`

## API surface

### Server-side (Agent class)

| Method                                         | Purpose                                                 |
| ---------------------------------------------- | ------------------------------------------------------- |
| `shouldConnectionBeReadonly(connection, ctx)`  | Hook called on connect. Return `true` to mark readonly. |
| `setConnectionReadonly(connection, readonly?)` | Dynamically change readonly status at any time.         |
| `isConnectionReadonly(connection)`             | Check a connection's current readonly status.           |

### Client-side (useAgent / AgentClient)

| Option                      | Purpose                                             |
| --------------------------- | --------------------------------------------------- |
| `onStateUpdateError(error)` | Callback when client-side `setState()` is rejected. |

RPC errors from blocked callables surface as rejected promises from `agent.call()`.

## How enforcement works

Readonly is enforced in two places:

### 1. Client-side `setState()` — in the message handler

When a client sends a `CF_AGENT_STATE` message, the `onMessage` wrapper checks `isConnectionReadonly(connection)` before processing it. If readonly, the server sends back a `CF_AGENT_STATE_ERROR` message and does **not** call `_setStateInternal`.

This path handles: `agent.setState(newState)` from client code (React hook, PartySocket, etc.).

### 2. Server-side `setState()` — in the public method

When a `@callable()` method calls `this.setState()`, the public `setState()` method checks `agentContext.getStore()` for the current connection. If the connection is readonly, `setState()` throws `Error("Connection is readonly")`.

The error propagates through the RPC handler's try/catch and is sent back as an RPC error response (`{ success: false, error: "Connection is readonly" }`).

This path handles: any `@callable()` that calls `this.setState()` internally.

### Why `setState()` and not the RPC handler?

We considered four options for blocking mutations from readonly connections:

| Approach                                             | Pros                                                                                   | Cons                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **A. Manual checks in each callable**                | Works today, explicit                                                                  | Boilerplate, easy to forget, security hole if missed     |
| **B. `@callable({ mutates: true })` decorator flag** | Declarative per-method                                                                 | Opt-in — developers have to remember to tag methods      |
| **C. `shouldAllowRPC(connection, method)` hook**     | Maximum flexibility                                                                    | More work for developers, whitelist vs blacklist footgun |
| **D. Check inside `setState()`**                     | Single enforcement point, no decorator changes, read-only callables work automatically | Side effects before `setState()` still run (see Caveats) |

We chose **D** because it matches the mental model: "readonly" means "cannot change state." A readonly connection can still call RPCs that _read_ data — it just can't write anything. The framework enforces this automatically without requiring any annotation on callable methods.

### Why `setState()` and not `_setStateInternal()`?

There are two paths into state mutation:

1. **Client-side** — arrives as a `CF_AGENT_STATE` message, already has its own readonly guard before calling `_setStateInternal(state, connection)`
2. **Server-side** — `this.setState(state)` calls `_setStateInternal(state, "server")`

Putting the check in `setState()` keeps each entry point responsible for its own access control:

- Client message handler → checks readonly → calls `_setStateInternal`
- `setState()` → checks readonly via context → calls `_setStateInternal`
- `_setStateInternal` → focuses on validation (`validateStateChange`), persistence, and broadcast

This also means `validateStateChange` (data validity) and the readonly check (access control) live at different levels. Access control comes first, before we even look at the data.

The `state` getter also calls `_setStateInternal` for initialization (persisting `initialState` on first access). These are framework-level operations that must bypass the readonly check, which is another reason the check belongs in the public `setState()`, not in `_setStateInternal()`.

### What about workflows?

`_workflow_updateState` calls `this.setState()`. But workflows don't have a connection in `agentContext` — the store's `connection` is `undefined`. So the readonly check passes harmlessly.

## Storage: connection state wrapping

### Evolution

The readonly flag storage went through three designs:

1. **SQL table** (original PR) — `CREATE TABLE cf_agents_readonly_connections`. Worked but added schema, queries, and cleanup logic for a single boolean.
2. **`connection.setState({ _readonly: true })`** (first refactor) — leveraged partyserver's built-in per-connection state, which survives hibernation. Much simpler. But had a fatal flaw: any call to `connection.setState({ ... })` without the callback form would overwrite `_readonly`.
3. **Namespaced connection attachment** (current) — wraps `connection.state` and `connection.setState()` on each connection to hide the `_cf_readonly` key from user code.

### How the wrapping works

When the Agent first encounters a connection (in `onConnect` or `onMessage`), `_ensureConnectionWrapped(connection)` is called. This method:

1. **Detects** whether `state` is an accessor property (getter) or a data property via `Object.getOwnPropertyDescriptor`
2. **Captures** raw state access — for accessor properties, it binds the original getter directly; for data properties, it snapshots the current value into a closure variable to avoid a circular reference after the override
3. **Stores** the raw accessors in a `WeakMap<Connection, { getRaw, setRaw }>` (the `_rawStateAccessors` map)
4. **Overrides** `connection.state` (getter) to strip `_cf_readonly` from the returned value
5. **Overrides** `connection.setState` to preserve `_cf_readonly` when user code sets new state

The accessor vs. data property distinction matters because partyserver defines `state` as a getter (via `Object.defineProperties`), but we also need to handle non-partyserver connections or future implementations where `state` might be a plain data property. Without this, the fallback `() => connection.state` would call our overridden getter after the property is replaced, creating an infinite loop.

After wrapping:

- `connection.state` returns everything **except** `_cf_readonly`
- `connection.setState({ myData: "foo" })` stores `{ _cf_readonly: <current>, myData: "foo" }` in the raw attachment
- `connection.setState((prev) => ({ ...prev, count: 1 }))` receives `prev` without `_cf_readonly`, but the flag is merged back in
- `setConnectionReadonly` / `isConnectionReadonly` use `_rawStateAccessors` to read/write the flag directly

### Why this required a partyserver change

Partyserver defines `state` and `setState` on connection objects via `Object.defineProperties` — and prior to our patch, both properties had `configurable: false` (the default). This prevented us from redefining them with `Object.defineProperty`.

The fix was a two-line change in partyserver: add `configurable: true` to both the `state` and `setState` descriptors in `createLazyConnection`. The default behavior is unchanged — `configurable` only means the property _can_ be redefined, not that it behaves differently.

### Why `_cf_readonly` and not `_readonly`?

The `_cf_` prefix namespaces the key to avoid collisions. Without it, a user storing `{ _readonly: false }` in their connection state would accidentally disable the feature. The prefix makes accidental collision vanishingly unlikely. The key name is defined once as the module-level constant `CF_READONLY_KEY` so it stays consistent across `_ensureConnectionWrapped`, `setConnectionReadonly`, and `isConnectionReadonly`.

### Why not a completely separate namespace (e.g. `{ _cf: { ... }, _user: { ... } }`)?

We considered storing all user state under a `_user` sub-key so there could be zero collision. But this breaks when user state is `null` or a primitive (you'd need to wrap it in an object). It also means MCP transport code — which stores `_standaloneSse` and `requestIds` in connection state — would need to be rewritten to use the `_user` namespace.

The single-key approach (`_cf_readonly` alongside user keys) is simpler, handles all state types, and doesn't require changes to existing code that uses `connection.state`.

### What about `getConnections()`?

Connections returned by `getConnections()` are the same JavaScript objects that were wrapped in `onConnect`/`onMessage` (partyserver's `createLazyConnection` checks `isWrapped(ws)` and returns the existing wrapper). So our `Object.defineProperty` overrides persist.

After hibernation, the Durable Object creates new wrapper objects for rehydrated WebSockets. The first `onMessage` call re-wraps them via `_ensureConnectionWrapped`.

## Caveats

### Side effects in callables still run

The readonly check happens inside `this.setState()`, not at the start of the callable. If a method does work before calling `setState()`, that work still executes:

```typescript
@callable()
async processOrder(orderId: string) {
  await sendEmail(orderId);      // runs
  await chargePayment(orderId);  // runs
  this.setState({ ... });        // throws — but damage is done
}
```

The recommended pattern is to put the state write first:

```typescript
@callable()
async processOrder(orderId: string) {
  this.setState({ ... });        // throws immediately for readonly
  await sendEmail(orderId);      // only runs if setState succeeded
  await chargePayment(orderId);
}
```

This is an inherent tradeoff of enforcing at the `setState` level rather than at the RPC handler level. We chose this approach because it doesn't require developers to annotate every callable, and most callables are simple state machines where `setState` is the primary operation. For the rare case of callables with expensive side effects, the "state write first" pattern is straightforward.

### Readonly is per-connection, not per-user

There's no built-in mapping from readonly status to user identity. If a user opens two tabs — one readonly, one writable — they have full write access from the second tab. Authentication and authorization are the developer's responsibility; readonly connections are a transport-level primitive.

### Readonly doesn't restrict `this.sql` or other side effects

Only `this.setState()` is gated. A callable can still write to SQL, send emails, call external APIs, or do anything else. Readonly means "cannot change the agent's shared state" — it's not a general permission system.

### HTTP requests bypass readonly entirely

Readonly is a WebSocket concept. HTTP requests (`onRequest`, `agentFetch`, `getAgentByName` + `agent.fetch()`) run with `connection: undefined` in the agent context, so the `setState()` check always passes.

This is by design:

- **Callables are WebSocket-only** — there's no HTTP callable path. `routeAgentRequest` only handles WebSocket upgrades; plain HTTP falls through to `onRequest`. So clients can't invoke `@callable()` methods over HTTP.
- **`onRequest` is developer-authored** — unlike the WebSocket message handler (which has automatic setState/RPC processing), `onRequest` is entirely custom code. There's no framework behavior to gate.
- **HTTP requests are stateless** — there's no persistent "connection" to mark as readonly. Each request stands alone. Standard HTTP auth (tokens, headers, cookies) is the right tool here.

If your `onRequest` handler calls `this.setState()`, it will always succeed. Protect HTTP endpoints with authentication/authorization in your `onRequest` implementation — this is standard practice and not something the readonly feature should absorb.

A future extension could add `shouldRequestBeReadonly(request)` to set a flag in the agent context for HTTP requests too, but that's essentially HTTP middleware/auth, which most frameworks leave to the developer.

## Testing

Tests live in `packages/agents/src/tests/readonly-connections.test.ts` and cover:

- `shouldConnectionBeReadonly` hook marking connections based on query params
- Client-side `setState()` blocked for readonly, allowed for writable
- Mutating RPCs (`incrementCount` → `this.setState()`) blocked for readonly
- Non-mutating RPCs (`getState`) allowed for readonly
- Mutating RPCs allowed for writable connections
- Dynamic readonly status changes at runtime
- State broadcasts reaching readonly connections (they can still observe)
- Readonly status restored after reconnection (hibernation survival)
- Multiple connections with mixed readonly states

The test agent (`TestReadonlyAgent` in `agents/readonly.ts`) has `incrementCount` (mutating) and `getState` (non-mutating) callables, plus `checkReadonly` and `setReadonly` for dynamic status changes.
