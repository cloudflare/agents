# API Reference

This document provides a high-level overview of the key functions, hooks, and components available in the `agents-sdk` and `hono-agents` libraries. It focuses on user-facing APIs, offering concise descriptions and usage examples to help you quickly integrate and utilize these tools in your projects.

## agents-sdk

### Core Agent Functionality

#### `Agent` Class

The base class for creating AI agents. Extend this class to define your agent's logic and behavior.

```typescript
import { Agent } from "agents-sdk";

class MyAgent extends Agent {
  async onRequest(request: Request): Promise<Response> {
    return new Response("Hello from MyAgent!");
  }
}
```

#### `routeAgentRequest` Function

Routes incoming HTTP requests to the appropriate Agent instance. This function is essential for integrating Agents with HTTP frameworks like Hono or Express.

```typescript
import { routeAgentRequest } from "agents-sdk";

// Example with Cloudflare Workers
addEventListener("fetch", (event) => {
  event.respondWith(routeAgentRequest(event.request, env));
});
```

#### `getAgentByName` Function

Retrieves an Agent instance by its name. Useful for interacting with specific Agent instances.

```typescript
import { getAgentByName } from "agents-sdk";

const myAgent = await getAgentByName(MyAgentNamespace, "my-agent-instance");
```

#### `AgentClient` Class

Provides a WebSocket client for connecting to and interacting with an Agent.

```typescript
import { AgentClient } from "agents-sdk/client";

const client = new AgentClient({
  agent: "my-agent",
  name: "my-agent-instance",
});

client.addEventListener("message", (event) => {
  console.log("Received:", event.data);
});

client.send("Hello, Agent!");
```

#### `agentFetch` Function

Allows making HTTP requests to an Agent instance.

```typescript
import { agentFetch } from "agents-sdk/client";

const response = await agentFetch(
  {
    agent: "my-agent",
    name: "my-agent-instance",
  },
  { method: "POST", body: "Some data" }
);

const data = await response.text();
console.log(data);
```

### React Integration

#### `useAgent` Hook

A React hook for managing the connection to an Agent and interacting with it.

```typescript jsx
import { useAgent } from 'agents-sdk/react';

function MyComponent() {
  const agent = useAgent({
    agent: 'my-agent',
    name: 'my-agent-instance',
    onMessage: (event) => {
      console.log('Received:', event.data);
    },
  });

  const sendMessage = () => {
    agent.send('Hello, Agent!');
  };

  return <button onClick={sendMessage}>Send Message</button>;
}
```

#### `useAgentChat` Hook

A React hook that simplifies building chat interfaces with AI Agents. It manages message history, input handling, and communication with the Agent.

```typescript jsx
import { useAgentChat } from 'agents-sdk/ai-react';
import { useAgent } from 'agents-sdk/react';

function ChatInterface() {
  const agent = useAgent({ agent: 'dialogue-agent' });
  const { messages, input, handleInputChange, handleSubmit } = useAgentChat({
    agent,
  });

  return (
    <div>
      {messages.map((message) => (
        <div key={message.id}>{message.content}</div>
      ))}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
```

### AI Chat Agent

#### `AIChatAgent` Class

Extends the `Agent` class to provide built-in chat capabilities, including message persistence and handling.

```typescript
import { AIChatAgent } from "agents-sdk/ai-chat-agent";

class MyChatAgent extends AIChatAgent {
  async onChatMessage(message: string): Promise<string> {
    // Process the message and return a response
    return `You said: ${message}`;
  }
}
```

### Scheduling

#### `schedule` Method

Schedules a task to be executed at a later time. This is a method on the `Agent` class.

```typescript
import { Agent } from "agents-sdk";

class MyAgent extends Agent {
  async initialize() {
    this.schedule("0 0 * * *", "dailyTask"); // Run daily at midnight
  }

  async dailyTask() {
    console.log("Running daily task!");
  }
}
```

### Decorators

#### `@unstable_callable`

Marks a method as callable by clients via RPC.

```typescript
import { Agent, unstable_callable } from "agents-sdk";

class MyAgent extends Agent {
  @unstable_callable()
  async myMethod(arg1: string, arg2: number): Promise<string> {
    return `Received: ${arg1}, ${arg2}`;
  }
}
```

### Types and Interfaces

#### `AgentContext`

The context object passed to the Agent constructor, providing access to storage and other runtime features.

#### `Connection`

Represents a WebSocket connection to the Agent.

#### `WSMessage`

Type representing a WebSocket message (string or ArrayBuffer).

#### `Schedule<T = string>`

Represents a scheduled task within an Agent.

```typescript
{
  id: string;
  callback: string;
  payload: T;
} & (
  | {
      type: "scheduled";
      time: number;
    }
  | {
      type: "delayed";
      time: number;
      delayInSeconds: number;
    }
  | {
      type: "cron";
      cron: string;
    }
);
```

## hono-agents

### `agentsMiddleware` Function

A Hono middleware that integrates Cloudflare Agents into your Hono application. It handles routing requests to the appropriate Agent.

```typescript
import { Hono } from "hono";
import { agentsMiddleware } from "hono-agents";

const app = new Hono();
app.use("*", agentsMiddleware());

export default app;
```

This API reference provides a starting point for understanding and using the `agents-sdk` and `hono-agents` libraries. For more detailed information, please refer to the individual package documentation and examples.
