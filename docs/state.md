# State Management

Agents provide built-in state management with automatic persistence and real-time synchronization across all connected clients.

## Overview

Agent state is:

- **Persistent** - Automatically saved to SQLite, survives restarts and hibernation
- **Synchronized** - Changes broadcast to all connected WebSocket clients instantly
- **Bidirectional** - Both server and clients can update state
- **Type-safe** - Full TypeScript support with generics

```typescript
import { Agent } from "agents";

type GameState = {
  players: string[];
  score: number;
  status: "waiting" | "playing" | "finished";
};

export class GameAgent extends Agent<Env, GameState> {
  // Default state for new agents
  initialState: GameState = {
    players: [],
    score: 0,
    status: "waiting"
  };

  // React to state changes
  onStateChanged(state: GameState, source: Connection | "server") {
    if (source !== "server" && state.players.length >= 2) {
      // Client added a player, start the game
      this.setState({ ...state, status: "playing" });
    }
  }

  addPlayer(name: string) {
    this.setState({
      ...this.state,
      players: [...this.state.players, name]
    });
  }
}
```

## Defining Initial State

Use the `initialState` property to define default values for new agent instances:

```typescript
type State = {
  messages: Message[];
  settings: UserSettings;
  lastActive: string | null;
};

export class ChatAgent extends Agent<Env, State> {
  initialState: State = {
    messages: [],
    settings: { theme: "dark", notifications: true },
    lastActive: null
  };
}
```

### Type Safety

The second generic parameter to `Agent<Env, State>` defines your state type:

```typescript
// State is fully typed
export class MyAgent extends Agent<Env, MyState> {
  initialState: MyState = { count: 0 };

  increment() {
    // TypeScript knows this.state is MyState
    this.setState({ count: this.state.count + 1 });
  }
}
```

### When Initial State Applies

Initial state is applied lazily on first access, not on every wake:

1. **New agent** - `initialState` is used and persisted
2. **Existing agent** - Persisted state is loaded from SQLite
3. **No `initialState` defined** - `this.state` is `undefined`

```typescript
async onStart() {
  // Safe to access - returns initialState if new, or persisted state
  console.log("Current count:", this.state.count);
}
```

## Reading State

Access the current state via the `this.state` getter:

```typescript
async onRequest(request: Request) {
  // Read current state
  const { players, status } = this.state;

  if (status === "waiting" && players.length < 2) {
    return new Response("Waiting for players...");
  }

  return new Response(JSON.stringify(this.state));
}
```

### Undefined State

If you don't define `initialState`, `this.state` returns `undefined`:

```typescript
export class MinimalAgent extends Agent<Env> {
  // No initialState defined

  async onConnect(connection: Connection) {
    if (!this.state) {
      // First time - initialize state
      this.setState({ initialized: true });
    }
  }
}
```

## Updating State

Use `setState()` to update state. This:

1. Saves to SQLite (persistent)
2. Broadcasts to all connected clients
3. Triggers `onStateChanged()` (after broadcast; best-effort)

```typescript
// Replace entire state
this.setState({
  players: ["Alice", "Bob"],
  score: 0,
  status: "playing"
});

// Update specific fields (spread existing state)
this.setState({
  ...this.state,
  score: this.state.score + 10
});
```

### State Must Be Serializable

State is stored as JSON, so it must be serializable:

```typescript
// Good - plain objects, arrays, primitives
this.setState({
  items: ["a", "b", "c"],
  count: 42,
  active: true,
  metadata: { key: "value" }
});

// Bad - functions, classes, circular references
this.setState({
  callback: () => {}, // Functions don't serialize
  date: new Date(), // Becomes string, loses methods
  self: this // Circular reference
});

// For dates, use ISO strings
this.setState({
  createdAt: new Date().toISOString()
});
```

## Responding to State Changes

Override `onStateChanged()` to react when state changes (notifications/side-effects):

```typescript
onStateChanged(state: GameState, source: Connection | "server") {
  console.log("State updated:", state);
  console.log("Updated by:", source === "server" ? "server" : source.id);
}
```

## Validating State Updates

If you want to validate or reject state updates, override `validateStateChange()`:

- **Runs before persistence and broadcast**
- **Must be synchronous**
- **Throwing aborts the update**

```typescript
validateStateChange(nextState: GameState, source: Connection | "server") {
  // Example: reject negative scores
  if (nextState.score < 0) {
    throw new Error("score cannot be negative");
  }
}
```

> `onStateChanged()` is not intended for validation; it is a notification hook and should not block broadcasts.
>
> **Migration note:** `onStateChanged` replaces the deprecated `onStateUpdate` (server-side hook). If you're using `onStateUpdate` on your agent class, rename it to `onStateChanged` — the signature and behavior are identical. A console warning will fire once per class until you rename it.

### The `source` Parameter

The `source` tells you who triggered the update:

| Value        | Meaning                             |
| ------------ | ----------------------------------- |
| `"server"`   | Agent called `setState()`           |
| `Connection` | A client pushed state via WebSocket |

This is useful for:

- Avoiding infinite loops (don't react to your own updates)
- Validating client input
- Triggering side effects only on client actions

```typescript
onStateChanged(state: State, source: Connection | "server") {
  // Ignore server-initiated updates
  if (source === "server") return;

  // A client updated state - validate and process
  const connection = source;
  console.log(`Client ${connection.id} updated state`);

  // Maybe trigger something based on the change
  if (state.status === "submitted") {
    this.processSubmission(state);
  }
}
```

### Common Pattern: Client-Driven Actions

```typescript
onStateChanged(state: State, source: Connection | "server") {
  if (source === "server") return;

  // Client added a message
  const lastMessage = state.messages[state.messages.length - 1];
  if (lastMessage && !lastMessage.processed) {
    // Process and update
    this.setState({
      ...state,
      messages: state.messages.map(m =>
        m.id === lastMessage.id ? { ...m, processed: true } : m
      )
    });
  }
}
```

## Client-Side State Sync

State synchronizes automatically with connected clients. See [Client SDK](./client-sdk.md) for full details.

### React (useAgent)

```typescript
import { useAgent } from "@cloudflare/agents/react";

function GameUI() {
  const agent = useAgent({
    agent: "game-agent",
    name: "room-123",
    onStateUpdate: (state, source) => {
      console.log("State updated:", state);
    }
  });

  // Push state to agent
  const addPlayer = (name: string) => {
    agent.setState({
      ...agent.state,
      players: [...agent.state.players, name]
    });
  };

  return <div>Players: {agent.state?.players.join(", ")}</div>;
}
```

### Vanilla JS (AgentClient)

```typescript
import { AgentClient } from "@cloudflare/agents/client";

const client = new AgentClient({
  agent: "game-agent",
  name: "room-123",
  onStateUpdate: (state) => {
    document.getElementById("score").textContent = state.score;
  }
});

// Push state update
client.setState({ ...client.state, score: 100 });
```

### State Flow

```
┌─────────────────────────────────────────────────────────────┐
│                         Agent                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                    this.state                       │    │
│  │              (persisted in SQLite)                  │    │
│  └─────────────────────────────────────────────────────┘    │
│           ▲                              │                  │
│           │ setState()                   │ broadcast        │
│           │                              ▼                  │
└───────────┼──────────────────────────────┼──────────────────┘
            │                              │
            │                              │ WebSocket
            │                              │
┌───────────┴──────────────────────────────┴───────────────────┐
│                        Clients                               │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐               │
│   │ Client 1 │    │ Client 2 │    │ Client 3 │               │
│   │  state   │    │  state   │    │  state   │               │
│   └──────────┘    └──────────┘    └──────────┘               │
│                                                              │
│   Any client can call setState() to push updates             │
└──────────────────────────────────────────────────────────────┘
```

## State from Workflows

When using [Workflows](./workflows.md), you can update agent state from workflow steps:

```typescript
// In your workflow
async run(event: AgentWorkflowEvent<Params>, step: AgentWorkflowStep) {
  // Replace entire state
  await step.updateAgentState({ status: "processing", progress: 0 });

  // Merge partial updates (preserves other fields)
  await step.mergeAgentState({ progress: 50 });

  // Reset to initialState
  await step.resetAgentState();

  return result;
}
```

These are durable operations - they persist even if the workflow retries.

## Patterns & Best Practices

### Keep State Small

State is broadcast to all clients on every change. For large data:

```typescript
// Bad - storing large arrays in state
initialState = {
  allMessages: []  // Could grow to thousands of items
};

// Good - store in SQL, keep state light
initialState = {
  messageCount: 0,
  lastMessageId: null
};

// Query SQL for full data
async getMessages(limit = 50) {
  return this.sql`SELECT * FROM messages ORDER BY created_at DESC LIMIT ${limit}`;
}
```

### Optimistic Updates

For responsive UIs, update client state immediately:

```typescript
// Client-side
function sendMessage(text: string) {
  const optimisticMessage = {
    id: crypto.randomUUID(),
    text,
    pending: true
  };

  // Update immediately
  agent.setState({
    ...agent.state,
    messages: [...agent.state.messages, optimisticMessage]
  });

  // Server will confirm/update
}

// Server-side
onStateChanged(state: State, source: Connection | "server") {
  if (source === "server") return;

  const pendingMessages = state.messages.filter(m => m.pending);
  for (const msg of pendingMessages) {
    // Validate and confirm
    this.setState({
      ...state,
      messages: state.messages.map(m =>
        m.id === msg.id ? { ...m, pending: false, timestamp: Date.now() } : m
      )
    });
  }
}
```

### State vs SQL

| Use State For                      | Use SQL For       |
| ---------------------------------- | ----------------- |
| UI state (loading, selected items) | Historical data   |
| Real-time counters                 | Large collections |
| Active session data                | Relationships     |
| Configuration                      | Queryable data    |

```typescript
export class ChatAgent extends Agent<Env, State> {
  // State: current UI state
  initialState = {
    typing: [],
    unreadCount: 0,
    activeUsers: []
  };

  // SQL: message history
  async getMessages(limit = 100) {
    return this.sql`
      SELECT * FROM messages
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }

  async saveMessage(message: Message) {
    this.sql`
      INSERT INTO messages (id, text, user_id, created_at)
      VALUES (${message.id}, ${message.text}, ${message.userId}, ${Date.now()})
    `;
    // Update state for real-time UI
    this.setState({
      ...this.state,
      unreadCount: this.state.unreadCount + 1
    });
  }
}
```

### Avoid Infinite Loops

Be careful not to trigger state updates in response to your own updates:

```typescript
// Bad - infinite loop
onStateChanged(state: State) {
  this.setState({ ...state, lastUpdated: Date.now() });
}

// Good - check source
onStateChanged(state: State, source: Connection | "server") {
  if (source === "server") return;  // Don't react to own updates
  this.setState({ ...state, lastUpdated: Date.now() });
}
```

## API Reference

### Properties

| Property       | Type    | Description                  |
| -------------- | ------- | ---------------------------- |
| `state`        | `State` | Current state (getter)       |
| `initialState` | `State` | Default state for new agents |

### Methods

| Method           | Signature                                                | Description                                   |
| ---------------- | -------------------------------------------------------- | --------------------------------------------- |
| `setState`       | `(state: State) => void`                                 | Update state, persist, and broadcast          |
| `onStateChanged` | `(state: State, source: Connection \| "server") => void` | Called after state is persisted and broadcast |

### Workflow Step Methods

| Method                          | Description                           |
| ------------------------------- | ------------------------------------- |
| `step.updateAgentState(state)`  | Replace agent state from workflow     |
| `step.mergeAgentState(partial)` | Merge partial state from workflow     |
| `step.resetAgentState()`        | Reset to `initialState` from workflow |

## Next Steps

- [Readonly Connections](./readonly-connections.md) - Restrict which connections can update state
- [Client SDK](./client-sdk.md) - Full client-side state sync documentation
- [Workflows](./workflows.md) - Durable state updates from workflows
- [SQL API](./sql.md) - When to use SQL instead of state
