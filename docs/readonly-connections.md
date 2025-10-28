# Readonly Connections

Readonly connections allow you to restrict certain WebSocket connections from modifying the agent's state while still allowing them to receive state updates and call RPC methods.

## Overview

When a connection is marked as readonly:

- ✅ It can **receive** state updates from the server
- ✅ It can **call** RPC methods (callable methods on the agent)
- ❌ It **cannot** send state updates via `setState()`

This is useful for scenarios like:

- **View-only modes**: Users who should only observe but not modify
- **Role-based access**: Restricting state modifications based on user roles
- **Multi-tenant scenarios**: Some tenants have read-only access
- **Audit/monitoring connections**: Observers that shouldn't affect the system

## API Reference

### Server-Side Methods

#### `shouldConnectionBeReadonly(connection, ctx): boolean`

An overridable hook that determines if a connection should be marked as readonly when it connects.

```typescript
export class MyAgent extends Agent<Env, State> {
  shouldConnectionBeReadonly(
    connection: Connection,
    ctx: ConnectionContext
  ): boolean {
    // Example: Check query parameters
    const url = new URL(ctx.request.url);
    return url.searchParams.get("readonly") === "true";
  }
}
```

#### `setConnectionReadonly(connection, readonly = true): void`

Explicitly mark or unmark a connection as readonly. Can be called at any time.

```typescript
export class MyAgent extends Agent<Env, State> {
  onConnect(connection: Connection, ctx: ConnectionContext) {
    // Dynamic logic to determine readonly status
    if (userIsViewer) {
      this.setConnectionReadonly(connection, true);
    }
  }

  @callable()
  async promoteToEditor(connectionId: string) {
    const conn = this.getConnections().find((c) => c.id === connectionId);
    if (conn) {
      this.setConnectionReadonly(conn, false);
    }
  }
}
```

#### `isConnectionReadonly(connection): boolean`

Check if a connection is currently marked as readonly.

```typescript
export class MyAgent extends Agent<Env, State> {
  @callable()
  async checkAccess() {
    const { connection } = getCurrentAgent();
    if (connection) {
      return {
        canEdit: !this.isConnectionReadonly(connection)
      };
    }
  }
}
```

### Client-Side API

#### `onStateUpdateError` Callback

Handle errors when a readonly connection attempts to update state.

```typescript
// Using AgentClient
const client = new AgentClient({
  agent: "MyAgent",
  name: "instance",
  onStateUpdateError: (error) => {
    console.error("State update failed:", error);
    alert("You don't have permission to modify the state");
  }
});

// Using React Hook
const agent = useAgent({
  agent: "MyAgent",
  name: "instance",
  onStateUpdateError: (error) => {
    setError(error);
    // Show user-friendly message
  }
});
```

## Usage Examples

### Example 1: Query Parameter Based Access

```typescript
export class DocumentAgent extends Agent<Env, DocumentState> {
  shouldConnectionBeReadonly(
    connection: Connection,
    ctx: ConnectionContext
  ): boolean {
    const url = new URL(ctx.request.url);
    const mode = url.searchParams.get("mode");
    return mode === "view";
  }
}

// Client connects with readonly mode
const agent = useAgent({
  agent: "DocumentAgent",
  name: "doc-123",
  query: { mode: "view" },
  onStateUpdateError: (error) => {
    toast.error("Document is in view-only mode");
  }
});
```

### Example 2: Role-Based Access Control

```typescript
export class CollaborativeAgent extends Agent<Env, CollabState> {
  shouldConnectionBeReadonly(
    connection: Connection,
    ctx: ConnectionContext
  ): boolean {
    const url = new URL(ctx.request.url);
    const role = url.searchParams.get("role");
    return role === "viewer" || role === "guest";
  }

  onConnect(connection: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);
    const userId = url.searchParams.get("userId");

    console.log(
      `User ${userId} connected (readonly: ${this.isConnectionReadonly(connection)})`
    );
  }

  @callable()
  async upgradeToEditor() {
    const { connection } = getCurrentAgent();
    if (!connection) return;

    // Check permissions (pseudo-code)
    const canUpgrade = await checkUserPermissions();
    if (canUpgrade) {
      this.setConnectionReadonly(connection, false);
      return { success: true };
    }

    throw new Error("Insufficient permissions");
  }
}
```

### Example 3: Admin Dashboard

```typescript
export class MonitoringAgent extends Agent<Env, SystemState> {
  shouldConnectionBeReadonly(
    connection: Connection,
    ctx: ConnectionContext
  ): boolean {
    const url = new URL(ctx.request.url);
    // Only admins can modify state
    return url.searchParams.get("admin") !== "true";
  }

  onStateUpdate(state: SystemState, source: Connection | "server") {
    if (source !== "server") {
      // Log who modified the state
      console.log(`State modified by connection ${source.id}`);
    }
  }
}

// Admin client (can modify)
const adminAgent = useAgent({
  agent: "MonitoringAgent",
  name: "system",
  query: { admin: "true" }
});

// Viewer client (readonly)
const viewerAgent = useAgent({
  agent: "MonitoringAgent",
  name: "system",
  query: { admin: "false" },
  onStateUpdateError: (error) => {
    console.log("Viewer cannot modify state");
  }
});
```

### Example 4: Dynamic Permission Changes

```typescript
export class GameAgent extends Agent<Env, GameState> {
  @callable()
  async startSpectatorMode() {
    const { connection } = getCurrentAgent();
    if (!connection) return;

    this.setConnectionReadonly(connection, true);
    return { mode: "spectator" };
  }

  @callable()
  async joinAsPlayer() {
    const { connection } = getCurrentAgent();
    if (!connection) return;

    const canJoin = this.state.players.length < 4;
    if (canJoin) {
      this.setConnectionReadonly(connection, false);
      return { mode: "player" };
    }

    throw new Error("Game is full");
  }

  @callable()
  async getMyPermissions() {
    const { connection } = getCurrentAgent();
    if (!connection) return null;

    return {
      canEdit: !this.isConnectionReadonly(connection),
      connectionId: connection.id
    };
  }
}

// Client-side React component
function GameComponent() {
  const [canEdit, setCanEdit] = useState(false);

  const agent = useAgent({
    agent: "GameAgent",
    name: "game-123",
    onStateUpdateError: (error) => {
      toast.error("Cannot modify game state in spectator mode");
    }
  });

  useEffect(() => {
    agent.call("getMyPermissions").then(perms => {
      setCanEdit(perms?.canEdit ?? false);
    });
  }, [agent]);

  return (
    <div>
      <button
        onClick={() => agent.call("joinAsPlayer")}
        disabled={canEdit}
      >
        Join as Player
      </button>

      <button
        onClick={() => agent.call("startSpectatorMode")}
        disabled={!canEdit}
      >
        Switch to Spectator
      </button>

      <div>
        {canEdit ? "You can modify the game" : "You are spectating"}
      </div>
    </div>
  );
}
```

## Behavior Details

### What Happens When a Readonly Connection Tries to Update State?

1. The connection sends a state update message
2. The server checks if the connection is readonly
3. If readonly, the server sends back an error response:
   ```json
   {
     "type": "cf_agent_state_error",
     "error": "Connection is readonly"
   }
   ```
4. The client's `onStateUpdateError` callback is invoked
5. The state is **not** updated on the server
6. Other connections are **not** notified

### State Synchronization

- Readonly connections still **receive** state updates from the server
- When state is updated (by server or other connections), readonly connections get the new state
- They just cannot **initiate** state changes themselves

### RPC Methods

- Readonly connections **can** call RPC methods (functions marked with `@callable()`)
- It's up to you to implement additional authorization checks within RPC methods if needed

### Connection Cleanup

- When a connection closes, it's automatically removed from the readonly tracking set
- No memory leaks from disconnected connections

## Best Practices

### 1. Combine with Authentication

```typescript
export class SecureAgent extends Agent<Env, State> {
  shouldConnectionBeReadonly(
    connection: Connection,
    ctx: ConnectionContext
  ): boolean {
    const url = new URL(ctx.request.url);
    const token = url.searchParams.get("token");

    // Verify token and get permissions
    const permissions = this.verifyToken(token);
    return !permissions.canWrite;
  }
}
```

### 2. Provide Clear User Feedback

```typescript
const agent = useAgent({
  agent: "MyAgent",
  name: "instance",
  onStateUpdateError: (error) => {
    // User-friendly messages
    if (error.includes("readonly")) {
      showToast("You're in view-only mode. Upgrade to edit.");
    }
  }
});
```

### 3. Check Permissions Before UI Actions

```typescript
function EditButton() {
  const [canEdit, setCanEdit] = useState(false);
  const agent = useAgent({ /* ... */ });

  useEffect(() => {
    agent.call("checkPermissions").then(perms => {
      setCanEdit(perms.canEdit);
    });
  }, []);

  return (
    <button disabled={!canEdit}>
      {canEdit ? "Edit" : "View Only"}
    </button>
  );
}
```

### 4. Log Access Attempts

```typescript
export class AuditedAgent extends Agent<Env, State> {
  onStateUpdate(state: State, source: Connection | "server") {
    if (source !== "server") {
      this.audit({
        action: "state_update",
        connectionId: source.id,
        readonly: this.isConnectionReadonly(source),
        timestamp: Date.now()
      });
    }
  }
}
```

## Migration Guide

If you have existing agents and want to add readonly connection support:

1. **Server-side**: No breaking changes. The feature is opt-in.
2. **Client-side**: Add `onStateUpdateError` handlers where needed.

```typescript
// Before
const agent = useAgent({
  agent: "MyAgent",
  name: "instance"
});

// After (with error handling)
const agent = useAgent({
  agent: "MyAgent",
  name: "instance",
  onStateUpdateError: (error) => {
    console.error("State update error:", error);
  }
});
```

## How It Works

### Persistence Across Hibernation

Readonly connection status is **automatically persisted to the agent's SQL storage**, which means:

✅ **Survives hibernation** - When an agent hibernates and wakes up, readonly connections maintain their status
✅ **No memory leaks** - Connections are automatically cleaned up when they close
✅ **Performance optimized** - Uses in-memory cache with SQL fallback

The implementation uses a two-tier approach:

1. **In-memory Set** for fast lookups during active operation
2. **SQL table** (`cf_agents_readonly_connections`) for persistence across hibernation

When checking if a connection is readonly:

1. First checks the in-memory cache (fast)
2. If not found, queries SQL storage (handles post-hibernation case)
3. Populates cache if found in storage

### Storage Details

The readonly status is stored in a dedicated table:

```sql
CREATE TABLE cf_agents_readonly_connections (
  connection_id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
)
```

All CRUD operations automatically sync both in-memory and persistent storage.

## Limitations

- Readonly status only applies to state updates via `setState()`
- RPC methods can still be called (implement your own checks if needed)

## Related

- [State Management](./index.md)
- [Connection Management](./context-management.md)
- [Cross-Domain Authentication](./cross-domain-authentication.md)
