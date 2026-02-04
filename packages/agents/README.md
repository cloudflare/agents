# agents

![npm install agents](../../assets/npm-install-agents.svg)

**Build software that thinks and does.**

Persistent AI agents on Cloudflare's global network. They remember context, reason through problems, schedule their own work, and take action—all without you managing servers.

```sh
npm create cloudflare@latest -- --template cloudflare/agents-starter
```

Or add to an existing project:

```sh
npm install agents
```

---

## Why Agents, Why Now

LLMs can reason, plan, and use tools—but they need infrastructure that matches their capabilities. Traditional serverless is stateless and ephemeral. Agents are persistent and purposeful.

```
From request handlers    →  to autonomous entities
From stateless functions →  to persistent intelligence

Traditional serverless:  Request → Response → Gone
Agents:                  Thinking, remembering, acting — continuously
```

**Pay only when active.** Agents hibernate between requests. You can have millions of agents—one per user, per session, per game room—each costs nothing when idle.

Built on Cloudflare Durable Objects, agents run globally, close to your users, with persistent state that survives restarts.

---

## Quick Example

A counter agent with real-time state sync and callable methods:

```typescript
// server.ts
import { Agent, callable } from "agents";

type State = { count: number };

export class CounterAgent extends Agent<Env, State> {
  initialState: State = { count: 0 };

  @callable()
  increment() {
    this.setState({ count: this.state.count + 1 });
    return this.state.count;
  }

  @callable()
  decrement() {
    this.setState({ count: this.state.count - 1 });
    return this.state.count;
  }
}
```

```tsx
// client.tsx
import { useAgent } from "agents/react";
import { useState } from "react";

function Counter() {
  const [count, setCount] = useState(0);

  const agent = useAgent<State>({
    agent: "counter-agent",
    name: "my-counter",
    onStateUpdate: (state) => setCount(state.count)
  });

  return (
    <div>
      <span>{count}</span>
      <button onClick={() => agent.stub.increment()}>+</button>
      <button onClick={() => agent.stub.decrement()}>-</button>
    </div>
  );
}
```

State changes sync to all connected clients automatically. Call methods like they're local functions.

---

## What You Can Build

| Use Case               | Why Agents                                            |
| ---------------------- | ----------------------------------------------------- |
| Multiplayer game rooms | Per-room state, real-time sync, hibernates when empty |
| Customer support bots  | Remembers conversation history, escalates to humans   |
| Collaborative editors  | Presence, cursors, document state                     |
| Approval workflows     | Long-running, pauses for human input, durable         |
| Personal AI assistants | Per-user memory, tool access via MCP                  |
| Notification systems   | Scheduled delivery, user preferences, retry logic     |

---

## Features

```
Core         State sync · Routing · HTTP & WebSockets · @callable RPC
Clients      React hook · Vanilla JS · Real-time state sync
Channels     WebSocket · HTTP · Email · (coming: SMS, Voice, Messengers)
Background   Queue · Scheduling · Workflows · Human-in-the-loop
AI           Chat agents · Tool calling · MCP servers & clients
Platform     Observability · Cross-domain auth · Resumable streams
```

### State Management

State persists across requests and syncs to all connected clients:

```typescript
export class MyAgent extends Agent<Env, { items: string[] }> {
  initialState = { items: [] };

  @callable()
  addItem(item: string) {
    this.setState({ items: [...this.state.items, item] });
  }

  onStateUpdate(state: State, source: Connection | "server") {
    // Called when state changes from any source
  }
}
```

### Callable Methods

Expose methods to clients with the `@callable()` decorator:

```typescript
@callable()
async processOrder(orderId: string, items: Item[]) {
  // Full type safety - clients call this like a local function
  const result = await this.validateAndProcess(orderId, items);
  return result;
}
```

```typescript
// Client
const result = await agent.stub.processOrder("order-123", items);
```

### Scheduling

Run tasks later, on intervals, or with cron expressions:

```typescript
// In 60 seconds
this.schedule(60, "sendReminder", { userId: "123" });

// Every hour
this.scheduleEvery(3600, "syncData");

// Daily at 9am UTC
this.schedule("0 9 * * *", "dailyReport");

// At a specific date
this.schedule(new Date("2025-12-31"), "yearEndTask");
```

### Background Tasks

Queue immediate background work:

```typescript
await this.queue("processUpload", { fileId: "abc" });
// Returns immediately, task runs in background
```

### WebSocket Connections

Handle real-time communication:

```typescript
async onConnect(connection: Connection) {
  console.log(`Client ${connection.id} connected`);
}

async onMessage(connection: Connection, message: unknown) {
  // Handle incoming messages
  connection.send(JSON.stringify({ received: true }));
}

async onClose(connection: Connection) {
  console.log(`Client ${connection.id} disconnected`);
}
```

### Email

Agents can receive and respond to emails:

```typescript
async onEmail(email: EmailMessage) {
  const from = email.from;
  const subject = email.headers.get("subject");
  // Process incoming email
}
```

---

## Client SDK

### React

```tsx
import { useAgent } from "agents/react";
import { useState } from "react";

function App() {
  const [state, setState] = useState<MyState | null>(null);

  const agent = useAgent<MyState>({
    agent: "my-agent",
    name: "instance-name",
    onStateUpdate: (newState) => setState(newState)
  });

  return (
    <div>
      <pre>{JSON.stringify(state, null, 2)}</pre>
      <button onClick={() => agent.stub.doSomething()}>Call Agent</button>
    </div>
  );
}
```

### Vanilla JavaScript

```typescript
import { AgentClient } from "agents/client";

const client = new AgentClient({
  agent: "my-agent",
  name: "instance-name",
  onStateUpdate: (state) => console.log("State:", state)
});

// Call methods
const result = await client.call("processData", [payload]);

// Or use the stub
const result = await client.stub.processData(payload);
```

---

## Workflows Integration

For durable, multi-step tasks that survive failures and can pause for human approval, integrate with [Cloudflare Workflows](https://developers.cloudflare.com/workflows/):

```typescript
import { AgentWorkflow } from "agents";

export class OrderWorkflow extends AgentWorkflow<OrderAgent, OrderParams> {
  async run(event, step) {
    // Step 1: Validate (retries automatically on failure)
    const validated = await step.do("validate", async () => {
      return validateOrder(event.payload);
    });

    // Step 2: Wait for human approval
    await this.reportProgress({ step: "approval", status: "pending" });
    const approval = await this.waitForApproval(step, { timeout: "7 days" });

    // Step 3: Process the approved order
    await step.do("process", async () => {
      return processOrder(validated, approval);
    });
  }
}
```

Workflows provide:

- **Durable execution** — steps retry automatically, state persists across failures
- **Human-in-the-loop** — pause for approval with `waitForApproval()`
- **Long-running tasks** — run for days or weeks
- **Progress tracking** — report status back to the agent

See [Workflows](./docs/workflows.md) and [Human in the Loop](./docs/human-in-the-loop.md).

---

## AI Chat Integration

For AI-powered chat experiences with persistent conversations, streaming responses, and tool support, see [`@cloudflare/ai-chat`](../ai-chat/README.md).

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";

export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish) {
    return streamText({
      model: openai("gpt-4o"),
      messages: this.messages,
      tools: this.tools,
      onFinish
    });
  }
}
```

```tsx
// Client
import { useAgentChat } from "@cloudflare/ai-chat/react";

const { messages, input, handleSubmit } = useAgentChat({
  agent: useAgent({ agent: "chat-agent" })
});
```

Features:

- Automatic message persistence
- Resumable streaming (survives disconnections)
- Server and client-side tool execution
- Human-in-the-loop approval for sensitive tools

---

## MCP (Model Context Protocol)

Agents integrate with MCP to act as servers (providing tools to AI assistants) or clients (using tools from other services).

### Creating an MCP Server

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";

export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({ name: "my-tools", version: "1.0.0" });

  async init() {
    this.server.registerTool(
      "lookup",
      { description: "Look up data", inputSchema: { query: z.string() } },
      async ({ query }) => {
        const result = await this.search(query);
        return { content: [{ type: "text", text: result }] };
      }
    );
  }
}

export default MyMCP.serve("/mcp", { binding: "MyMCP" });
```

### Using MCP Tools

```typescript
// Connect to external MCP servers
await this.addMcpServer(
  "weather-service",
  "https://weather-mcp.example.com/mcp",
  {
    transport: { type: "streamable-http" }
  }
);

// Use with AI SDK
const result = await generateText({
  model: openai("gpt-4o"),
  tools: this.mcp.getTools(),
  prompt: "What's the weather in Tokyo?"
});
```

---

## Configuration

Add your agent to `wrangler.jsonc`:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "MyAgent", "class_name": "MyAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyAgent"] }]
}
```

Route requests to your agent:

```typescript
import { routeAgentRequest } from "agents";

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

---

## Coming Soon

- **Browse the Web** — Headless browser for web scraping and automation
- **Cloudflare Sandboxes** — Isolated environments for code execution
- **SMS, Voice, Messengers** — Multi-channel communication

---

## Learn More

[Getting Started](./docs/getting-started.md) ·
[State Management](./docs/state.md) ·
[Scheduling](./docs/scheduling.md) ·
[Callable Methods](./docs/callable-methods.md) ·
[MCP Integration](./docs/mcp-client.md) ·
[Full Documentation](./docs/index.md)

---

## Contributing

Contributions are welcome, especially when:

- You've opened an issue as an RFC to discuss your proposal
- The contribution isn't "AI slop" — LLMs are tools, but vibe-coded PRs won't meet the quality bar
- You're open to feedback to ensure changes fit the SDK's goals

Small fixes, type bugs, and documentation improvements can be raised directly as PRs.

---

## License

MIT licensed. See the [LICENSE](../../LICENSE) file for details.

---

<p align="center">
  <i>Build something that thinks. Ship something that does.</i>
</p>
