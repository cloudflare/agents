# Client SDK

Connect to agents from any JavaScript runtime — browsers, Node.js, Deno, Bun, or edge functions — using WebSockets or HTTP. The SDK provides real-time state synchronization, RPC method calls, and streaming responses.

## Overview

The client SDK offers two ways to connect with a websocket connection, and one way to make HTTP requests.

| Client        | Use Case                                                    |
| ------------- | ----------------------------------------------------------- |
| `useAgent`    | React hook with automatic reconnection and state management |
| `AgentClient` | Vanilla JavaScript/TypeScript class for any environment     |
| `agentFetch`  | HTTP requests when WebSocket isn't needed                   |

All clients provide:

- **Bidirectional state sync** - Push and receive state updates in real-time
- **RPC calls** - Call agent methods with typed arguments and return values
- **Streaming** - Handle chunked responses for AI completions
- **Auto-reconnection** - Built on [PartySocket](https://docs.partykit.io/reference/partysocket-api/) for reliable connections

## Quick Start

### React

```tsx
import { useAgent } from "agents/react";

function Chat() {
  const agent = useAgent({
    agent: "ChatAgent",
    name: "room-123",
    onStateUpdate: (state) => {
      console.log("New state:", state);
    }
  });

  const sendMessage = async () => {
    const response = await agent.call("sendMessage", ["Hello!"]);
    console.log("Response:", response);
  };

  return <button onClick={sendMessage}>Send</button>;
}
```

### Vanilla JavaScript

```typescript
import { AgentClient } from "agents/client";

const client = new AgentClient({
  agent: "ChatAgent",
  name: "room-123",
  host: "your-worker.your-subdomain.workers.dev",
  onStateUpdate: (state) => {
    console.log("New state:", state);
  }
});

// Call a method
const response = await client.call("sendMessage", ["Hello!"]);
```

## Connecting to Agents

### Agent Naming

The `agent` parameter is your agent class name. It's automatically converted from camelCase to kebab-case for the URL:

```typescript
// These are equivalent:
useAgent({ agent: "ChatAgent" }); // → /agents/chat-agent/...
useAgent({ agent: "MyCustomAgent" }); // → /agents/my-custom-agent/...
useAgent({ agent: "LOUD_AGENT" }); // → /agents/loud-agent/...
```

### Instance Names

The `name` parameter identifies a specific agent instance. If omitted, defaults to `"default"`:

```typescript
// Connect to a specific chat room
useAgent({ agent: "ChatAgent", name: "room-123" });

// Connect to a user's personal agent
useAgent({ agent: "UserAgent", name: userId });

// Uses "default" instance
useAgent({ agent: "ChatAgent" });
```

### Connection Options

Both `useAgent` and `AgentClient` accept PartySocket options:

```typescript
useAgent({
  agent: "ChatAgent",
  name: "room-123",

  // Connection settings
  host: "my-worker.workers.dev", // Custom host (defaults to current origin)
  path: "/custom/path", // Custom path prefix

  // Query parameters (sent on connection)
  query: {
    token: "abc123",
    version: "2"
  },

  // Event handlers
  onOpen: () => console.log("Connected"),
  onClose: () => console.log("Disconnected"),
  onError: (error) => console.error("Error:", error)
});
```

### Async Query Parameters

For authentication tokens or other async data, pass a function that returns a Promise:

```typescript
useAgent({
  agent: "ChatAgent",
  name: "room-123",

  // Async query - called before connecting
  query: async () => {
    const token = await getAuthToken();
    return { token };
  },

  // Dependencies that trigger re-fetching the query
  queryDeps: [userId],

  // Cache TTL for the query result (default: 5 minutes)
  cacheTtl: 60 * 1000 // 1 minute
});
```

The query function is cached and only re-called when:

- `queryDeps` change
- `cacheTtl` expires
- The component remounts

## State Synchronization

Agents can maintain state that syncs bidirectionally with all connected clients.

### Receiving State Updates

```typescript
const agent = useAgent({
  agent: "GameAgent",
  name: "game-123",
  onStateUpdate: (state, source) => {
    // state: The new state from the agent
    // source: "server" (agent pushed) or "client" (you pushed)
    console.log(`State updated from ${source}:`, state);
    setGameState(state);
  }
});
```

### Pushing State Updates

```typescript
// Update the agent's state from the client
agent.setState({ score: 100, level: 5 });
```

When you call `setState()`:

1. The state is sent to the agent over WebSocket
2. The agent's `onStateUpdate()` method is called
3. The agent broadcasts the new state to all connected clients
4. Your `onStateUpdate` callback fires with `source: "client"`

### State Flow

```
┌─────────┐                      ┌─────────┐
│ Client  │ ── setState() ────▶  │  Agent  │
│         │                      │         │
│         │ ◀── onStateUpdate ── │         │
└─────────┘      (broadcast)     └─────────┘
```

## Calling Agent Methods (RPC)

Call methods on your agent that are decorated with `@callable()`.

> **Note:** The `@callable()` decorator is only required for methods called from external runtimes (browsers, other services). When calling from within the same Worker, you can use standard [Durable Object RPC](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/#invoke-rpc-methods) directly on the stub without the decorator.

### Using call()

```typescript
// Basic call
const result = await agent.call("getUser", [userId]);

// Call with multiple arguments
const result = await agent.call("createPost", [title, content, tags]);

// Call with no arguments
const result = await agent.call("getStats");
```

### Using the Stub Proxy

The `stub` property provides a cleaner syntax for method calls:

```typescript
// Instead of:
const user = await agent.call("getUser", ["user-123"]);

// You can write:
const user = await agent.stub.getUser("user-123");

// Multiple arguments work naturally:
const post = await agent.stub.createPost(title, content, tags);
```

### TypeScript Integration

For full type safety, pass your Agent class as a type parameter:

```typescript
import type { MyAgent } from "./agents/my-agent";

const agent = useAgent<MyAgent, MyAgentState>({
  agent: "MyAgent",
  name: "instance-1"
});

// Now stub methods are fully typed!
const result = await agent.stub.processData({ input: "test" });
//    ^? Awaited<ReturnType<MyAgent["processData"]>>
```

### Streaming Responses

For methods that return `StreamingResponse`, handle chunks as they arrive:

```typescript
// Agent-side:
@callable()
async generateText(prompt: string) {
  return new StreamingResponse(async (stream) => {
    for await (const chunk of llm.stream(prompt)) {
      await stream.write(chunk);
    }
  });
}

// Client-side:
await agent.call("generateText", [prompt], {
  onChunk: (chunk) => {
    // Called for each chunk
    appendToOutput(chunk);
  },
  onDone: (finalResult) => {
    // Called when stream completes
    console.log("Complete:", finalResult);
  },
  onError: (error) => {
    // Called if streaming fails
    console.error("Stream error:", error);
  }
});
```

## HTTP Requests with agentFetch

For one-off requests without maintaining a WebSocket connection:

```typescript
import { agentFetch } from "agents/client";

// GET request
const response = await agentFetch({
  agent: "DataAgent",
  name: "instance-1",
  host: "my-worker.workers.dev"
});

const data = await response.json();

// POST request with body
const response = await agentFetch(
  {
    agent: "DataAgent",
    name: "instance-1",
    host: "my-worker.workers.dev"
  },
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "process" })
  }
);
```

**When to use `agentFetch` vs WebSocket:**

| Use `agentFetch`                | Use `useAgent`/`AgentClient` |
| ------------------------------- | ---------------------------- |
| One-time requests               | Real-time updates needed     |
| Server-to-server calls          | Bidirectional communication  |
| Simple REST-style API           | State synchronization        |
| No persistent connection needed | Multiple RPC calls           |

## React Hook Reference

### UseAgentOptions

```typescript
type UseAgentOptions<State> = {
  // Required
  agent: string; // Agent class name

  // Optional
  name?: string; // Instance name (default: "default")
  host?: string; // Custom host
  path?: string; // Custom path prefix

  // Query parameters
  query?:
    | Record<string, string | null>
    | (() => Promise<Record<string, string | null>>);
  queryDeps?: unknown[]; // Dependencies for async query
  cacheTtl?: number; // Query cache TTL in ms (default: 5 min)

  // Callbacks
  onStateUpdate?: (state: State, source: "server" | "client") => void;
  onMcpUpdate?: (mcpServers: MCPServersState) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
  onMessage?: (message: MessageEvent) => void;
};
```

### Return Value

```typescript
const agent = useAgent(options);

agent.agent;           // string - Kebab-case agent name
agent.name;            // string - Instance name
agent.setState(state); // void - Push state to agent
agent.call(method, args?, streamOptions?); // Promise<T> - Call agent method
agent.stub;            // Proxy - Typed method calls
agent.send(data);      // void - Send raw WebSocket message
agent.close();         // void - Close connection
agent.reconnect();     // void - Force reconnection
```

## Vanilla JS Reference

### AgentClientOptions

```typescript
type AgentClientOptions<State> = {
  // Required
  agent: string; // Agent class name
  host: string; // Worker host

  // Optional
  name?: string; // Instance name (default: "default")
  path?: string; // Custom path prefix
  query?: Record<string, string>;

  // Callbacks
  onStateUpdate?: (state: State, source: "server" | "client") => void;
};
```

### AgentClient Methods

```typescript
const client = new AgentClient(options);

client.agent;           // string - Kebab-case agent name
client.name;            // string - Instance name
client.setState(state); // void - Push state to agent
client.call(method, args?, streamOptions?); // Promise<T> - Call agent method
client.send(data);      // void - Send raw WebSocket message
client.close();         // void - Close connection
client.reconnect();     // void - Force reconnection

// Event listeners (inherited from PartySocket)
client.addEventListener("open", () => {});
client.addEventListener("close", () => {});
client.addEventListener("error", () => {});
client.addEventListener("message", () => {});
```

## MCP Server Integration

If your agent uses MCP (Model Context Protocol) servers, you can receive updates about their state:

```typescript
const agent = useAgent({
  agent: "AssistantAgent",
  name: "session-123",
  onMcpUpdate: (mcpServers) => {
    // mcpServers is a record of server states
    for (const [serverId, server] of Object.entries(mcpServers)) {
      console.log(`${serverId}: ${server.connectionState}`);
      console.log(`Tools: ${server.tools?.map((t) => t.name).join(", ")}`);
    }
  }
});
```

## Error Handling

### Connection Errors

```typescript
const agent = useAgent({
  agent: "MyAgent",
  onError: (error) => {
    console.error("WebSocket error:", error);
  },
  onClose: () => {
    console.log("Connection closed, will auto-reconnect...");
  }
});
```

### RPC Errors

```typescript
try {
  const result = await agent.call("riskyMethod", [data]);
} catch (error) {
  // Error thrown by the agent method
  console.error("RPC failed:", error.message);
}
```

### Streaming Errors

```typescript
await agent.call("streamingMethod", [data], {
  onChunk: (chunk) => handleChunk(chunk),
  onError: (errorMessage) => {
    // Stream-specific error handling
    console.error("Stream error:", errorMessage);
  }
});
```

## Best Practices

### 1. Use Typed Stubs

```typescript
// Prefer this:
const user = await agent.stub.getUser(id);

// Over this:
const user = await agent.call("getUser", [id]);
```

### 2. Reconnection is Automatic

The client auto-reconnects and the agent automatically sends the current state on each connection. Your `onStateUpdate` callback will fire with the latest state — no manual re-sync needed.

### 3. Optimize Query Caching

```typescript
// For auth tokens that expire hourly:
useAgent({
  query: async () => ({ token: await getToken() }),
  cacheTtl: 55 * 60 * 1000, // Refresh 5 min before expiry
  queryDeps: [userId] // Refresh if user changes
});
```

### 4. Clean Up Connections

In vanilla JS, close connections when done:

```typescript
const client = new AgentClient({ agent: "MyAgent", host: "..." });

// When done:
client.close();
```

React's `useAgent` handles cleanup automatically on unmount.
