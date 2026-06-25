# Readonly Connections

Readonly connections restrict certain WebSocket clients from modifying agent state while still letting them receive state updates and call non-mutating RPC methods.

## Overview

When a connection is marked as readonly:

- It **receives** state updates from the server
- It **can call** RPC methods that don't modify state
- It **cannot** call `this.setState()` — neither via client-side `setState()` nor via a `@callable()` method that calls `this.setState()` internally

```typescript
import { Agent, type Connection, type ConnectionContext } from "agents";

export class DocAgent extends Agent<Env, DocState> {
  shouldConnectionBeReadonly(connection: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);
    return url.searchParams.get("mode") === "view";
  }
}
```

```typescript
// Client - view-only mode
const agent = useAgent({
  agent: "DocAgent",
  name: "doc-123",
  query: { mode: "view" },
  onStateUpdateError: (error) => {
    toast.error("You're in view-only mode");
  }
});
```

## Marking connections as readonly

### On connect

Override `shouldConnectionBeReadonly` to evaluate each connection when it first connects. Return `true` to mark it readonly.

```typescript
export class MyAgent extends Agent<Env, State> {
  shouldConnectionBeReadonly(
    connection: Connection,
    ctx: ConnectionContext
  ): boolean {
    const url = new URL(ctx.request.url);
    const role = url.searchParams.get("role");
    return role === "viewer" || role === "guest";
  }
}
```

This hook runs before the initial state is sent to the client, so the connection is readonly from the very first message.

### At any time

Use `setConnectionReadonly` to change a connection's readonly status dynamically:

```typescript
export class GameAgent extends Agent<Env, GameState> {
  @callable()
  async startSpectating() {
    const { connection } = getCurrentAgent();
    if (connection) {
      this.setConnectionReadonly(connection, true);
    }
  }

  @callable()
  async joinAsPlayer() {
    const { connection } = getCurrentAgent();
    if (connection) {
      this.setConnectionReadonly(connection, false);
    }
  }
}
```

### Letting a connection toggle its own status

A connection can toggle its own readonly status via a callable. This is useful for "lock/unlock" UIs where viewers can opt into editing mode:

```typescript
import { Agent, callable, getCurrentAgent } from "agents";

export class CollabAgent extends Agent<Env, State> {
  @callable()
  async setMyReadonly(readonly: boolean) {
    const { connection } = getCurrentAgent();
    if (connection) {
      this.setConnectionReadonly(connection, readonly);
    }
  }
}
```

On the client:

```typescript
// Toggle between readonly and writable
await agent.call("setMyReadonly", [true]); // lock
await agent.call("setMyReadonly", [false]); // unlock
```

### Checking status

Use `isConnectionReadonly` to check a connection's current status:

```typescript
@callable()
async getPermissions() {
  const { connection } = getCurrentAgent();
  if (connection) {
    return { canEdit: !this.isConnectionReadonly(connection) };
  }
}
```

## Handling errors on the client

Errors surface in two ways depending on how the write was attempted:

- **Client-side `setState()`** — the server sends a `cf_agent_state_error` message. Handle it with the `onStateUpdateError` callback.
- **`@callable()` methods** — the RPC call rejects with an error. Handle it with a `try`/`catch` around `agent.call()`.

> **Note:** `onStateUpdateError` also fires when `validateStateChange` rejects a client-originated state update (with the message `"State update rejected"`). This makes the callback useful for handling any rejected state write, not just readonly errors.

```typescript
const agent = useAgent({
  agent: "MyAgent",
  name: "instance",
  // Fires when client-side setState() is blocked
  onStateUpdateError: (error) => {
    setError(error);
  }
});

// Fires when a callable that writes state is blocked
try {
  await agent.call("updateSettings", [newSettings]);
} catch (e) {
  setError(e instanceof Error ? e.message : String(e)); // "Connection is readonly"
}
```

To avoid showing errors in the first place, check permissions before rendering edit controls:

```typescript
function Editor() {
  const [canEdit, setCanEdit] = useState(false);
  const agent = useAgent({ agent: "MyAgent", name: "instance" });

  useEffect(() => {
    agent.call("getPermissions").then((p) => setCanEdit(p.canEdit));
  }, []);

  return <button disabled={!canEdit}>{canEdit ? "Edit" : "View Only"}</button>;
}
```

## API reference

### `shouldConnectionBeReadonly(connection, ctx)`

Called when a connection is established. Override to control which connections are readonly.

| Parameter    | Type                | Description                  |
| ------------ | ------------------- | ---------------------------- |
| `connection` | `Connection`        | The connecting client        |
| `ctx`        | `ConnectionContext` | Contains the upgrade request |
| **Returns**  | `boolean`           | `true` to mark as readonly   |

Default: returns `false` (all connections are writable).

### `setConnectionReadonly(connection, readonly?)`

Mark or unmark a connection as readonly. Can be called at any time.

| Parameter    | Type         | Description                               |
| ------------ | ------------ | ----------------------------------------- |
| `connection` | `Connection` | The connection to update                  |
| `readonly`   | `boolean`    | `true` to make readonly (default: `true`) |

### `isConnectionReadonly(connection)`

Check if a connection is currently readonly.

| Parameter    | Type         | Description             |
| ------------ | ------------ | ----------------------- |
| `connection` | `Connection` | The connection to check |
| **Returns**  | `boolean`    | `true` if readonly      |

### `onStateUpdateError` (client)

Callback on `AgentClient` and `useAgent` options. Called when the server rejects a state update.

| Parameter | Type     | Description                   |
| --------- | -------- | ----------------------------- |
| `error`   | `string` | Error message from the server |

## How it works

Readonly status is stored in the connection's WebSocket attachment, which persists through the WebSocket Hibernation API. The flag is namespaced internally so it cannot be accidentally overwritten by `connection.setState()`. This means:

- **Survives hibernation** — the flag is serialized and restored when the agent wakes up
- **No cleanup needed** — connection state is automatically discarded when the connection closes
- **Zero overhead** — no database tables or queries, just the connection's built-in attachment
- **Safe from user code** — `connection.state` and `connection.setState()` never expose or overwrite the readonly flag

When a readonly connection tries to modify state, the server blocks it — regardless of whether the write comes from client-side `setState()` or from a `@callable()` method:

```
Client (readonly)                     Agent
       │                                │
       │  setState({ count: 1 })        │
       │ ─────────────────────────────▶ │  Check readonly → blocked
       │  ◀───────────────────────────  │
       │  cf_agent_state_error          │
       │                                │
       │  call("increment")             │
       │ ─────────────────────────────▶ │  increment() calls this.setState()
       │                                │  Check readonly → throw
       │  ◀───────────────────────────  │
       │  RPC error: "Connection is     │
       │              readonly"         │
       │                                │
       │  call("getPermissions")        │
       │ ─────────────────────────────▶ │  getPermissions() — no setState()
       │  ◀───────────────────────────  │
       │  RPC result: { canEdit: false }│
```

## What readonly does and does not restrict

| Action                                                 | Allowed? |
| ------------------------------------------------------ | -------- |
| Receive state broadcasts                               | Yes      |
| Call `@callable()` methods that don't write state      | Yes      |
| Call `@callable()` methods that call `this.setState()` | **No**   |
| Send state updates via client-side `setState()`        | **No**   |

The enforcement happens inside `setState()` itself. When a `@callable()` method tries to call `this.setState()` and the current connection context is readonly, the framework throws an `Error("Connection is readonly")`. This means you don't need manual permission checks in your RPC methods — any callable that writes state is automatically blocked for readonly connections.

## Caveats

### Side effects in callables still run

The readonly check happens inside `this.setState()`, not at the start of the callable. If your method has side effects before the state write, those will still execute:

```typescript
@callable()
async processOrder(orderId: string) {
  await sendConfirmationEmail(orderId); // runs even for readonly connections
  await chargePayment(orderId);         // runs too
  this.setState({ ...this.state, orders: [...this.state.orders, orderId] }); // throws
}
```

To avoid this, either check permissions before side effects or structure your code so the state write comes first:

```typescript
@callable()
async processOrder(orderId: string) {
  // Write state first — throws immediately for readonly connections
  this.setState({ ...this.state, orders: [...this.state.orders, orderId] });
  // Side effects only run if setState succeeded
  await sendConfirmationEmail(orderId);
  await chargePayment(orderId);
}
```

## Related

- [State Management](./state.md)
- [HTTP & WebSockets](./http-websockets.md)
- [Callable Methods](./callable-methods.md)
