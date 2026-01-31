# HTTP & WebSockets

Agents handle both HTTP requests and WebSocket connections, giving you flexibility to build REST APIs, real-time applications, or hybrid architectures.

## Overview

Every agent can respond to:

- **HTTP requests** via `onRequest()` - REST APIs, webhooks, file uploads
- **WebSocket connections** via `onConnect()`, `onMessage()`, `onClose()` - Real-time bidirectional communication

```typescript
import { Agent } from "agents";

export class MyAgent extends Agent {
  // Handle HTTP requests
  onRequest(request: Request): Response {
    return new Response("Hello from HTTP!");
  }

  // Handle WebSocket connections
  onConnect(connection: Connection, ctx: ConnectionContext) {
    connection.send("Welcome!");
  }

  onMessage(connection: Connection, message: WSMessage) {
    // Echo back
    connection.send(message);
  }
}
```

## Lifecycle Hooks

Agents have several lifecycle hooks that are called at different points:

| Hook                                          | When Called                                               |
| --------------------------------------------- | --------------------------------------------------------- |
| `onStart(props?)`                             | Once when the agent first starts (before any connections) |
| `onRequest(request)`                          | When an HTTP request is received (non-WebSocket)          |
| `onConnect(connection, ctx)`                  | When a new WebSocket connection is established            |
| `onMessage(connection, message)`              | When a WebSocket message is received                      |
| `onClose(connection, code, reason, wasClean)` | When a WebSocket connection closes                        |
| `onError(connection, error)`                  | When a WebSocket error occurs                             |
| `onError(error)`                              | When a server error occurs (overloaded)                   |

### Lifecycle Flow

```
Agent Created
     ↓
  onStart()  ←── Called once, before any connections
     ↓
┌─────────────────────────────────────┐
│  For each request:                  │
│                                     │
│  HTTP Request ──→ onRequest()       │
│                                     │
│  WebSocket ──→ onConnect()          │
│       ↓                             │
│  Messages ──→ onMessage() (repeat)  │
│       ↓                             │
│  Disconnect ──→ onClose()           │
└─────────────────────────────────────┘
```

## HTTP Requests

Handle HTTP requests with `onRequest()`. This is called for any non-WebSocket request to your agent.

```typescript
export class ApiAgent extends Agent {
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Route by path
    if (url.pathname.endsWith("/status")) {
      return Response.json({
        status: "ok",
        connections: this.getConnections().length
      });
    }

    if (url.pathname.endsWith("/data") && request.method === "POST") {
      const data = await request.json();
      // Process data...
      return Response.json({ received: true });
    }

    return new Response("Not found", { status: 404 });
  }
}
```

### Common HTTP Patterns

**REST API with CORS:**

```typescript
onRequest(request: Request): Response {
  // Handle preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  return Response.json(
    { data: "..." },
    { headers: { "Access-Control-Allow-Origin": "*" } }
  );
}
```

**File Upload:**

```typescript
async onRequest(request: Request): Promise<Response> {
  if (request.method === "POST") {
    const formData = await request.formData();
    const file = formData.get("file") as File;

    // Process file...
    const content = await file.text();

    return Response.json({ filename: file.name, size: file.size });
  }
  return new Response("Method not allowed", { status: 405 });
}
```

## WebSocket Connections

WebSockets enable real-time bidirectional communication between clients and your agent.

### Connection Lifecycle

```typescript
export class ChatAgent extends Agent {
  // Called when a client connects
  onConnect(connection: Connection, ctx: ConnectionContext) {
    // ctx.request contains the original HTTP request (for auth, headers, etc.)
    const url = new URL(ctx.request.url);
    const token = url.searchParams.get("token");

    console.log(`Client ${connection.id} connected`);
    connection.send(JSON.stringify({ type: "welcome", id: connection.id }));
  }

  // Called for each message from this connection
  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message === "string") {
      const data = JSON.parse(message);
      // Handle message...
    } else {
      // Binary message (ArrayBuffer)
    }
  }

  // Called when connection closes
  onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ) {
    console.log(`Client ${connection.id} disconnected: ${code} ${reason}`);
  }

  // Called on WebSocket errors
  onError(connection: Connection, error: unknown) {
    console.error(`Error on connection ${connection.id}:`, error);
  }
}
```

### The Connection Object

Each WebSocket connection is represented by a `Connection` object:

```typescript
interface Connection<TState = unknown> {
  /** Unique connection identifier */
  id: string;

  /** The agent instance name this connection belongs to */
  server: string;

  /** Per-connection state (read-only, use setState to update) */
  state: TState | null;

  /** Update connection state */
  setState(state: TState | ((prev: TState | null) => TState)): void;

  /** Send a message to this connection */
  send(message: string | ArrayBuffer): void;

  /** Close this connection */
  close(code?: number, reason?: string): void;
}
```

### Message Types

Messages can be strings or binary:

```typescript
onMessage(connection: Connection, message: WSMessage) {
  if (typeof message === "string") {
    // Text message - usually JSON
    const data = JSON.parse(message);
    this.handleTextMessage(connection, data);
  } else {
    // Binary message - ArrayBuffer or ArrayBufferView
    this.handleBinaryMessage(connection, message);
  }
}
```

## Connection Management

### Getting Connections

```typescript
// Get all connections
const connections = this.getConnections();

// Get a specific connection by ID
const connection = this.getConnection("abc123");

// Get connections with a specific tag
const adminConnections = this.getConnections("admin");
```

### Broadcasting

Send a message to all connected clients:

```typescript
// Broadcast to everyone
this.broadcast(JSON.stringify({ type: "update", data: "..." }));

// Broadcast to everyone except specific connections
this.broadcast(
  JSON.stringify({ type: "user-typing", userId: "123" }),
  ["connection-id-to-exclude"] // Don't send to the originator
);
```

### Connection Tags

Tag connections for easy filtering. Override `getConnectionTags()` to assign tags:

```typescript
export class ChatAgent extends Agent {
  // Called when a connection is established
  getConnectionTags(connection: Connection, ctx: ConnectionContext): string[] {
    const url = new URL(ctx.request.url);
    const role = url.searchParams.get("role");

    const tags: string[] = [];
    if (role === "admin") tags.push("admin");
    if (role === "moderator") tags.push("moderator");

    return tags; // Up to 9 tags, max 256 chars each
  }

  // Later, broadcast only to admins
  notifyAdmins(message: string) {
    for (const conn of this.getConnections("admin")) {
      conn.send(message);
    }
  }
}
```

## Per-Connection State

Store data specific to each connection using `connection.state` and `connection.setState()`:

```typescript
type ConnectionState = {
  username: string;
  joinedAt: number;
  messageCount: number;
};

export class ChatAgent extends Agent {
  onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);

    // Initialize connection state
    connection.setState({
      username: url.searchParams.get("username") || "Anonymous",
      joinedAt: Date.now(),
      messageCount: 0
    });
  }

  onMessage(connection: Connection<ConnectionState>, message: WSMessage) {
    // Update message count using functional update
    connection.setState((prev) => ({
      ...prev!,
      messageCount: (prev?.messageCount || 0) + 1
    }));

    // Access current state
    const { username, messageCount } = connection.state!;
    console.log(`${username} sent message #${messageCount}`);
  }
}
```

**Important:** Connection state is:

- **Immutable** - Read via `connection.state`, update via `connection.setState()`
- **Per-connection** - Each connection has its own state
- **Persisted across hibernation** - Survives agent sleep/wake cycles

## The `onStart` Hook

`onStart()` is called once when the agent first starts, before any connections are established:

```typescript
export class MyAgent extends Agent {
  private cache: Map<string, unknown> = new Map();

  async onStart() {
    // Initialize resources
    console.log(`Agent ${this.name} starting...`);

    // Load data from storage
    const savedData = this.sql`SELECT * FROM cache`;
    for (const row of savedData) {
      this.cache.set(row.key, row.value);
    }

    // Restore MCP connections, check workflows, etc.
    // (Agent does this automatically, but you can add custom logic)
  }

  onConnect(connection: Connection) {
    // By the time connections arrive, onStart has completed
  }
}
```

## Error Handling

Handle errors gracefully with `onError`:

```typescript
export class MyAgent extends Agent {
  // WebSocket connection error
  onError(connection: Connection, error: unknown): void {
    console.error(`WebSocket error on ${connection.id}:`, error);
    connection.send(
      JSON.stringify({ type: "error", message: "Connection error" })
    );
  }

  // Server error (overloaded signature - no connection parameter)
  onError(error: unknown): void {
    console.error("Server error:", error);
    // Log to external service, etc.
  }
}
```

## Hibernation

Agents support hibernation - they can sleep when inactive and wake when needed. This saves resources while maintaining WebSocket connections.

### Enabling Hibernation

Hibernation is enabled by default. To disable:

```typescript
export class AlwaysOnAgent extends Agent {
  static options = { hibernate: false };
}
```

### How Hibernation Works

1. Agent is active, handling connections
2. After ~10 seconds of no messages, agent hibernates (sleeps)
3. WebSocket connections remain open (handled by Cloudflare)
4. When a message arrives, agent wakes up
5. `onMessage` is called as normal

### What Persists Across Hibernation

| Persists                   | Does Not Persist    |
| -------------------------- | ------------------- |
| `this.state` (agent state) | In-memory variables |
| `connection.state`         | Timers/intervals    |
| SQLite data (`this.sql`)   | Promises in flight  |
| Connection metadata        | Local caches        |

**Best Practice:** Store important data in `this.state` or SQLite, not in class properties:

```typescript
export class MyAgent extends Agent<Env, { counter: number }> {
  initialState = { counter: 0 };

  // ❌ Don't do this - lost on hibernation
  private localCounter = 0;

  onMessage(connection: Connection, message: WSMessage) {
    // ✅ Do this - persists
    this.setState({ counter: this.state.counter + 1 });

    // ❌ Lost after hibernation
    this.localCounter++;
  }
}
```

## Common Patterns

### Authentication on Connect

Validate users when they connect:

```typescript
export class SecureAgent extends Agent {
  async onConnect(connection: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);
    const token = url.searchParams.get("token");

    if (!token || !(await this.validateToken(token))) {
      connection.close(4001, "Unauthorized");
      return;
    }

    const user = await this.getUserFromToken(token);
    connection.setState({ userId: user.id, role: user.role });

    connection.send(JSON.stringify({ type: "authenticated", user }));
  }

  private async validateToken(token: string): Promise<boolean> {
    // Validate JWT, check database, etc.
    return true;
  }
}
```

### Chat Room with Broadcast

```typescript
type Message = {
  type: "message" | "join" | "leave";
  user: string;
  text?: string;
  timestamp: number;
};

export class ChatRoom extends Agent {
  onConnect(connection: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);
    const username = url.searchParams.get("username") || "Anonymous";

    connection.setState({ username });

    // Notify others
    this.broadcast(
      JSON.stringify({
        type: "join",
        user: username,
        timestamp: Date.now()
      } satisfies Message),
      [connection.id] // Don't send to the joining user
    );
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;

    const { username } = connection.state as { username: string };

    // Broadcast to everyone
    this.broadcast(
      JSON.stringify({
        type: "message",
        user: username,
        text: message,
        timestamp: Date.now()
      } satisfies Message)
    );
  }

  onClose(connection: Connection) {
    const { username } = (connection.state as { username: string }) || {};
    if (username) {
      this.broadcast(
        JSON.stringify({
          type: "leave",
          user: username,
          timestamp: Date.now()
        } satisfies Message)
      );
    }
  }
}
```

### Presence Tracking

Track who's online using per-connection state. This pattern is clean because connection state is automatically cleaned up when users disconnect:

```typescript
type UserState = {
  name: string;
  joinedAt: number;
  lastSeen: number;
};

export class PresenceAgent extends Agent {
  onConnect(connection: Connection<UserState>, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);
    const name = url.searchParams.get("name") || "Anonymous";

    // Store user data on the connection itself
    connection.setState({
      name,
      joinedAt: Date.now(),
      lastSeen: Date.now()
    });

    // Send current presence to new user
    connection.send(
      JSON.stringify({
        type: "presence",
        users: this.getPresence()
      })
    );

    // Notify others that someone joined
    this.broadcastPresence();
  }

  onClose(connection: Connection) {
    // No manual cleanup needed - connection state is automatically gone
    // Just broadcast updated presence to remaining users
    this.broadcastPresence();
  }

  // Heartbeat to update lastSeen
  onMessage(connection: Connection<UserState>, message: WSMessage) {
    if (message === "ping") {
      connection.setState((prev) => ({
        ...prev!,
        lastSeen: Date.now()
      }));
      connection.send("pong");
    }
  }

  // Build presence from all connections
  private getPresence() {
    const users: Record<string, { name: string; lastSeen: number }> = {};
    for (const conn of this.getConnections<UserState>()) {
      if (conn.state) {
        users[conn.id] = {
          name: conn.state.name,
          lastSeen: conn.state.lastSeen
        };
      }
    }
    return users;
  }

  private broadcastPresence() {
    this.broadcast(
      JSON.stringify({
        type: "presence",
        users: this.getPresence()
      })
    );
  }
}
```

## API Reference

### Agent Lifecycle Methods

| Method      | Signature                                                       | Description                   |
| ----------- | --------------------------------------------------------------- | ----------------------------- |
| `onStart`   | `(props?) => void \| Promise<void>`                             | Called once when agent starts |
| `onRequest` | `(request: Request) => Response \| Promise<Response>`           | Handle HTTP requests          |
| `onConnect` | `(connection, ctx) => void \| Promise<void>`                    | WebSocket connected           |
| `onMessage` | `(connection, message) => void \| Promise<void>`                | Message received              |
| `onClose`   | `(connection, code, reason, wasClean) => void \| Promise<void>` | Connection closed             |
| `onError`   | `(connection, error) => void \| Promise<void>`                  | WebSocket error               |
| `onError`   | `(error) => void \| Promise<void>`                              | Server error (overload)       |

### Connection Management Methods

| Method              | Signature                                 | Description                            |
| ------------------- | ----------------------------------------- | -------------------------------------- |
| `getConnections`    | `(tag?: string) => Iterable<Connection>`  | Get all connections, optionally by tag |
| `getConnection`     | `(id: string) => Connection \| undefined` | Get connection by ID                   |
| `getConnectionTags` | `(connection, ctx) => string[]`           | Override to tag connections            |
| `broadcast`         | `(message, without?: string[]) => void`   | Send to all connections                |

### Connection Object

| Property/Method | Type                                       | Description                      |
| --------------- | ------------------------------------------ | -------------------------------- |
| `id`            | `string`                                   | Unique connection identifier     |
| `server`        | `string`                                   | Agent instance name              |
| `state`         | `T \| null`                                | Per-connection state (read-only) |
| `setState`      | `(state \| (prev) => state) => void`       | Update connection state          |
| `send`          | `(message: string \| ArrayBuffer) => void` | Send message                     |
| `close`         | `(code?, reason?) => void`                 | Close connection                 |

### Agent Properties

| Property     | Type                 | Description                         |
| ------------ | -------------------- | ----------------------------------- |
| `this.name`  | `string`             | Agent instance name                 |
| `this.state` | `State`              | Agent state (use with `setState()`) |
| `this.env`   | `Env`                | Environment bindings                |
| `this.ctx`   | `DurableObjectState` | Durable Object context              |
