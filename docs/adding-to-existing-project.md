# Adding Agents to an Existing Project

This guide shows how to add agents to an existing Cloudflare Workers project. If you're starting fresh, see [Getting Started](./getting-started.md) instead.

---

## Prerequisites

- An existing Cloudflare Workers project with `wrangler.jsonc`
- Node.js 18+

---

## 1. Install the Package

```bash
npm install agents
```

For React applications, no additional packages are needed—React bindings are included.

For Hono applications:

```bash
npm install agents hono-agents
```

---

## 2. Create an Agent

Create a new file for your agent (e.g., `src/agents/counter.ts`):

```typescript
import { Agent } from "agents";

type CounterState = {
  count: number;
};

export class Counter extends Agent<Env, CounterState> {
  initialState: CounterState = { count: 0 };

  increment() {
    this.setState({ count: this.state.count + 1 });
    return this.state.count;
  }

  decrement() {
    this.setState({ count: this.state.count - 1 });
    return this.state.count;
  }
}
```

---

## 3. Update wrangler.jsonc

Add the Durable Object binding and migration:

```jsonc
{
  "name": "my-existing-project",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"], // Required for agents

  // Add this section
  "durable_objects": {
    "bindings": [
      {
        "name": "Counter",
        "class_name": "Counter"
      }
    ]
  },

  // Add this section
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["Counter"]
    }
  ]
}
```

**Key points:**

- `name` in bindings becomes the property on `env` (e.g., `env.Counter`)
- `class_name` must match your exported class name exactly
- `new_sqlite_classes` enables SQLite storage for state persistence
- The `nodejs_compat` flag is required for the agents package

---

## 4. Export the Agent Class

Your agent class must be exported from your main entry point. Update your `src/index.ts`:

```typescript
// Export the agent class (required for Durable Objects)
export { Counter } from "./agents/counter";

// Your existing exports...
export default {
  // ...
};
```

---

## 5. Wire Up Routing

Choose the approach that matches your project structure:

### Plain Workers (fetch handler)

```typescript
import { routeAgentRequest } from "agents";
export { Counter } from "./agents/counter";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Try agent routing first
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Your existing routing logic
    const url = new URL(request.url);
    if (url.pathname === "/api/hello") {
      return Response.json({ message: "Hello!" });
    }

    return new Response("Not found", { status: 404 });
  }
};
```

### Hono

```typescript
import { Hono } from "hono";
import { agentsMiddleware } from "hono-agents";
export { Counter } from "./agents/counter";

const app = new Hono<{ Bindings: Env }>();

// Add agents middleware - handles WebSocket upgrades and agent HTTP requests
app.use("*", agentsMiddleware());

// Your existing routes continue to work
app.get("/api/hello", (c) => c.json({ message: "Hello!" }));

export default app;
```

### With Static Assets

If you're serving static assets alongside agents:

```typescript
import { routeAgentRequest } from "agents";
export { Counter } from "./agents/counter";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Try agent routing first
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Fall back to static assets
    return env.ASSETS.fetch(request);
  }
};
```

Make sure your `wrangler.jsonc` has the assets binding:

```jsonc
{
  "assets": {
    "binding": "ASSETS"
  }
}
```

---

## 6. Add TypeScript Types

Update your `Env` type to include the agent namespace. Create or update `env.d.ts`:

```typescript
import type { Counter } from "./agents/counter";

interface Env {
  // Your existing bindings
  MY_KV: KVNamespace;
  MY_DB: D1Database;

  // Add agent bindings
  Counter: DurableObjectNamespace<Counter>;
}
```

---

## 7. Connect from the Frontend

### React

```tsx
import { useState } from "react";
import { useAgent } from "agents/react";

type CounterState = { count: number };

function CounterWidget() {
  const [count, setCount] = useState(0);

  const agent = useAgent<CounterState>({
    agent: "Counter",
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

### Vanilla JavaScript

```typescript
import { AgentClient } from "agents/client";

const agent = new AgentClient({
  agent: "Counter",
  name: "user-123", // Optional: unique instance name
  onStateUpdate: (state) => {
    document.getElementById("count").textContent = state.count;
  }
});

// Call methods
document.getElementById("increment").onclick = () => agent.call("increment");
```

---

## Adding Multiple Agents

Add more agents by extending the configuration:

```typescript
// src/agents/chat.ts
export class Chat extends Agent<Env, ChatState> {
  // ...
}

// src/agents/scheduler.ts
export class Scheduler extends Agent<Env> {
  // ...
}
```

Update `wrangler.jsonc`:

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "Counter", "class_name": "Counter" },
      { "name": "Chat", "class_name": "Chat" },
      { "name": "Scheduler", "class_name": "Scheduler" }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["Counter", "Chat", "Scheduler"]
    }
  ]
}
```

Export all agents from your entry point:

```typescript
export { Counter } from "./agents/counter";
export { Chat } from "./agents/chat";
export { Scheduler } from "./agents/scheduler";
```

---

## Common Integration Patterns

### Agents Behind Authentication

Check auth before routing to agents:

```typescript
export default {
  async fetch(request: Request, env: Env) {
    // Check auth for agent routes
    if (request.url.includes("/agents/")) {
      const authResult = await checkAuth(request, env);
      if (!authResult.valid) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // ... rest of routing
  }
};
```

### Custom Agent Path Prefix

By default, agents are routed at `/agents/{agent-name}/{instance-name}`. You can customize this:

```typescript
import { routeAgentRequest } from "agents";

const agentResponse = await routeAgentRequest(request, env, {
  prefix: "/api/agents" // Now routes at /api/agents/{agent-name}/{instance-name}
});
```

### Accessing Agents from Server Code

You can interact with agents directly from your Worker code:

```typescript
import { getAgentByName } from "agents";

export default {
  async fetch(request: Request, env: Env) {
    if (request.url.endsWith("/api/increment")) {
      // Get a specific agent instance
      const counter = await getAgentByName(env.Counter, "shared-counter");
      const newCount = await counter.increment();
      return Response.json({ count: newCount });
    }
    // ...
  }
};
```

---

## Troubleshooting

### "Agent not found" or 404 errors

1. **Check the export** - Agent class must be exported from your main entry point
2. **Check the binding** - `class_name` in `wrangler.jsonc` must match the exported class name exactly
3. **Check the route** - Default route is `/agents/{agent-name}/{instance-name}`

### "No such Durable Object class" error

Add the migration to `wrangler.jsonc`:

```jsonc
"migrations": [
  {
    "tag": "v1",
    "new_sqlite_classes": ["YourAgentClass"]
  }
]
```

### WebSocket connection fails

Ensure your routing passes the response through unchanged:

```typescript
// ✅ Correct - return the response directly
const agentResponse = await routeAgentRequest(request, env);
if (agentResponse) return agentResponse;

// ❌ Wrong - don't wrap or modify the response
const agentResponse = await routeAgentRequest(request, env);
if (agentResponse) return new Response(agentResponse.body); // Breaks WebSocket
```

### State not persisting

Check that:

1. You're using `this.setState()`, not mutating `this.state` directly
2. The agent class is in `new_sqlite_classes` in migrations
3. You're connecting to the same agent instance name

---

## Next Steps

- [State Management](./state.md) - Deep dive into agent state
- [Scheduling](./scheduling.md) - Background tasks and cron jobs
- [Agent Class](./agent-class.md) - Full lifecycle and methods
- [Client SDK](./client-sdk.md) - Complete client API reference
