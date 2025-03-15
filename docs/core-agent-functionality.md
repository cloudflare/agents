# Core Agent Functionality

This document provides an in-depth explanation of the `Agent` class from the `agents-sdk`, which serves as the foundation for building intelligent and stateful AI agents. We will cover the agent lifecycle, state management, and various communication patterns.

## The `Agent` Class

The `Agent` class is the core building block for creating AI agents within the `agents-sdk`. It provides a structured environment for managing agent state, handling communication, and scheduling tasks. To create an agent, you extend this class and override its methods to define your agent's specific behavior.

```typescript
import { Agent } from "agents-sdk";

export class MyAgent extends Agent {
  // Override methods here to define agent behavior
}
```

## Agent Lifecycle

The `Agent` class has a defined lifecycle, with specific methods called at different stages. Understanding this lifecycle is crucial for building robust and predictable agents.

### Initialization

While there isn't a single explicit "init" method, the constructor of your `Agent` subclass is the place to perform any initial setup. Additionally, you can use the `initialize` method for asynchronous initialization tasks. This method is called after the agent is constructed but before it starts handling requests.

```typescript
import { Agent } from "agents-sdk";

export class MyAgent extends Agent {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    // Perform synchronous initialization here
  }

  async initialize() {
    // Perform asynchronous initialization here, such as loading data
    // from a database or external source.
  }
}
```

### `onRequest`

This method is called when the agent receives an HTTP request. You can access the request object and return a `Response` object.

```typescript
import { Agent } from "agents-sdk";

export class MyAgent extends Agent {
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/hello") {
      return new Response("Hello from my agent!");
    }
    return new Response("Not Found", { status: 404 });
  }
}
```

### `onConnect`

This method is called when a WebSocket connection is established with the agent. You can use this method to initialize the connection and send initial messages.

```typescript
import { Agent } from "agents-sdk";
import { Connection } from "agents-sdk";

export class MyAgent extends Agent {
  async onConnect(connection: Connection) {
    console.log(`New connection: ${connection.id}`);
    connection.send("Welcome to the agent!");
  }
}
```

### `onMessage`

This method is called when the agent receives a message over a WebSocket connection. You can access the connection object and the message data.

```typescript
import { Agent } from "agents-sdk";
import { Connection, WSMessage } from "agents-sdk";

export class MyAgent extends Agent {
  async onMessage(connection: Connection, message: WSMessage) {
    console.log(`Received message from ${connection.id}: ${message}`);
    connection.send(`You said: ${message}`);
  }
}
```

### `alarm`

This method is called when a scheduled alarm fires. You can use this method to perform tasks at specific times or intervals. See [scheduling-tasks-with-agents.md](scheduling-tasks-with-agents.md) for more details.

```typescript
import { Agent } from "agents-sdk";

export class MyAgent extends Agent {
  async alarm() {
    console.log("Alarm fired!");
    // Perform scheduled tasks here
  }
}
```

### `destroy`

This method is called when the agent is being destroyed. You can use this method to clean up any resources or perform any final tasks.

```typescript
import { Agent } from "agents-sdk";

export class MyAgent extends Agent {
  async destroy() {
    console.log("Agent is being destroyed.");
    // Clean up resources here
  }
}
```

## State Management

The `Agent` class provides built-in state management capabilities. This allows you to persist data across requests and WebSocket connections.

### `state`

This property provides access to the agent's current state. The state is persisted automatically between invocations of the Durable Object.

```typescript
import { Agent } from "agents-sdk";

interface MyAgentState {
  counter: number;
}

export class MyAgent extends Agent<unknown, MyAgentState> {
  async onRequest(request: Request): Promise<Response> {
    return new Response(`Counter: ${this.state?.counter}`);
  }
}
```

### `setState`

This method allows you to update the agent's state. When you call `setState`, the new state is automatically persisted.

```typescript
import { Agent } from "agents-sdk";

interface MyAgentState {
  counter: number;
}

export class MyAgent extends Agent<unknown, MyAgentState> {
  async onRequest(request: Request): Promise<Response> {
    this.setState({ counter: (this.state?.counter || 0) + 1 });
    return new Response(
      `Counter incremented. New value: ${this.state?.counter}`
    );
  }
}
```

### `onStateUpdate`

This method is called whenever the agent's state is updated. You can use this method to perform actions based on state changes.

```typescript
import { Agent } from "agents-sdk";
import { Connection } from "agents-sdk";

interface MyAgentState {
  counter: number;
}

export class MyAgent extends Agent<unknown, MyAgentState> {
  onStateUpdate(
    state: MyAgentState | undefined,
    source: Connection | "server"
  ) {
    console.log(
      `State updated. New counter value: ${state?.counter}, Source: ${source}`
    );
  }
}
```

## Communication Patterns

The `Agent` class supports various communication patterns, including HTTP requests, WebSocket connections, and direct client calls.

### HTTP Requests (`onRequest`)

As shown earlier, the `onRequest` method allows you to handle HTTP requests. This is the primary way for clients to interact with the agent over HTTP.

### WebSocket Connections (`onConnect`, `onMessage`)

The `onConnect` and `onMessage` methods allow you to handle WebSocket connections. This enables persistent, bidirectional communication between clients and the agent.

### Direct Client Calls (`AgentClient`)

The `agents-sdk` provides an `AgentClient` class that allows clients to directly call methods on the agent. This is useful for implementing RPC-style communication.

```typescript
import { Agent, unstable_callable } from "agents-sdk";

export class MyAgent extends Agent {
  @unstable_callable()
  async myMethod(arg1: string, arg2: number): Promise<string> {
    return `Received: ${arg1}, ${arg2}`;
  }
}
```

On the client side:

```typescript
import { AgentClient } from "agents-sdk/client";

const client = new AgentClient({
  agent: "my-agent",
  name: "my-instance",
});

client.addEventListener("open", async () => {
  const result = await client.call("myMethod", ["hello", 123]);
  console.log(result);
});
```

**Important:** Methods must be decorated with `@unstable_callable()` to be accessible via `AgentClient`. This decorator is still considered unstable and may change in future releases.

## Practical Examples

### Example 1: Counter Agent

This agent maintains a counter that increments with each HTTP request.

```typescript
import { Agent } from "agents-sdk";

interface CounterAgentState {
  counter: number;
}

export class CounterAgent extends Agent<unknown, CounterAgentState> {
  async onRequest(request: Request): Promise<Response> {
    this.setState({ counter: (this.state?.counter || 0) + 1 });
    return new Response(`Counter: ${this.state?.counter}`);
  }
}
```

### Example 2: Echo Agent

This agent echoes back messages received over a WebSocket connection.

```typescript
import { Agent } from "agents-sdk";
import { Connection, WSMessage } from "agents-sdk";

export class EchoAgent extends Agent {
  async onConnect(connection: Connection) {
    connection.send("Welcome to the echo agent!");
  }

  async onMessage(connection: Connection, message: WSMessage) {
    connection.send(`You said: ${message}`);
  }
}
```

## Conclusion

The `Agent` class provides a powerful and flexible framework for building intelligent and stateful AI agents. By understanding the agent lifecycle, state management capabilities, and communication patterns, you can create sophisticated agents that meet your specific needs.
