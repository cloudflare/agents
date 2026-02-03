# Routing

This guide explains how requests are routed to agents, how naming works, and patterns for organizing your agents.

---

## How Routing Works

When a request comes in, `routeAgentRequest()` examines the URL and routes it to the appropriate agent instance:

```
https://your-worker.dev/agents/{agent-name}/{instance-name}
                              └─────┬─────┘ └─────┬──────┘
                            Class name      Unique instance ID
                            (kebab-case)
```

**Example URLs:**

| URL                        | Agent Class | Instance   |
| -------------------------- | ----------- | ---------- |
| `/agents/counter/user-123` | `Counter`   | `user-123` |
| `/agents/chat-room/lobby`  | `ChatRoom`  | `lobby`    |
| `/agents/my-agent/default` | `MyAgent`   | `default`  |

---

## Name Resolution

Agent class names are automatically converted to kebab-case for URLs:

| Class Name    | URL Path                   |
| ------------- | -------------------------- |
| `Counter`     | `/agents/counter/...`      |
| `MyAgent`     | `/agents/my-agent/...`     |
| `ChatRoom`    | `/agents/chat-room/...`    |
| `AIAssistant` | `/agents/ai-assistant/...` |

The router matches both the original name and kebab-case version, so these all work:

- `useAgent({ agent: "Counter" })` → `/agents/counter/...`
- `useAgent({ agent: "counter" })` → `/agents/counter/...`

---

## Using `routeAgentRequest()`

The `routeAgentRequest()` function is the main entry point for agent routing:

```typescript
import { routeAgentRequest } from "agents";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Route to agents - returns Response or undefined
    const agentResponse = await routeAgentRequest(request, env);

    if (agentResponse) {
      return agentResponse;
    }

    // No agent matched - handle other routes
    return new Response("Not found", { status: 404 });
  }
};
```

### Enabling CORS

For cross-origin requests (common when your frontend is on a different domain):

```typescript
const response = await routeAgentRequest(request, env, {
  cors: true // Enable default CORS headers
});
```

Or with custom CORS headers:

```typescript
const response = await routeAgentRequest(request, env, {
  cors: {
    "Access-Control-Allow-Origin": "https://myapp.com",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  }
});
```

---

## Instance Naming Patterns

The instance name (the last part of the URL) determines which agent instance handles the request. Each unique name gets its own isolated agent with its own state.

### Per-User Agents

Each user gets their own agent instance:

```typescript
// Client
const agent = useAgent({
  agent: "UserProfile",
  name: `user-${userId}` // e.g., "user-abc123"
});
```

```
/agents/user-profile/user-abc123  → User abc123's agent
/agents/user-profile/user-xyz789  → User xyz789's agent (separate instance)
```

### Shared Rooms

Multiple users share the same agent instance:

```typescript
// Client
const agent = useAgent({
  agent: "ChatRoom",
  name: roomId // e.g., "general" or "room-42"
});
```

```
/agents/chat-room/general  → All users in "general" share this agent
```

### Global Singleton

A single instance for the entire application:

```typescript
// Client
const agent = useAgent({
  agent: "AppConfig",
  name: "default" // Or any consistent name
});
```

### Dynamic Naming

Generate instance names based on context:

```typescript
// Per-session
const agent = useAgent({
  agent: "Session",
  name: sessionId
});

// Per-document
const agent = useAgent({
  agent: "Document",
  name: `doc-${documentId}`
});

// Per-game
const agent = useAgent({
  agent: "Game",
  name: `game-${gameId}-${Date.now()}`
});
```

---

## Custom URL Routing

For advanced use cases where you need control over the URL structure, you can bypass the default `/agents/{agent}/{name}` pattern.

### Using `basePath` (Client-Side)

The `basePath` option lets clients connect to any URL path:

```typescript
// Client connects to /user instead of /agents/user-agent/...
const agent = useAgent({
  agent: "UserAgent", // Required but ignored when basePath is set
  basePath: "user" // → connects to /user
});
```

This is useful when:

- You want clean URLs without the `/agents/` prefix
- The instance name is determined server-side (e.g., from auth/session)
- You're integrating with an existing URL structure

### Server-Side Instance Selection

When using `basePath`, the server must handle routing. Use `getAgentByName()` to get the agent instance, then forward the request with `fetch()`:

```typescript
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Custom routing - server determines instance from session
    if (url.pathname === "/user") {
      const session = await getSession(request);
      const agent = await getAgentByName(env.UserAgent, session.userId);
      return agent.fetch(request); // Forward request directly to agent
    }

    // Default routing for standard /agents/... paths
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

### Custom Path with Dynamic Instance

Route different paths to different instances:

```typescript
// Route /chat/{room} to ChatRoom agent
if (url.pathname.startsWith("/chat/")) {
  const roomId = url.pathname.replace("/chat/", "");
  const agent = await getAgentByName(env.ChatRoom, roomId);
  return agent.fetch(request);
}

// Route /doc/{id} to Document agent
if (url.pathname.startsWith("/doc/")) {
  const docId = url.pathname.replace("/doc/", "");
  const agent = await getAgentByName(env.Document, docId);
  return agent.fetch(request);
}
```

### Receiving the Instance Identity (Client-Side)

When using `basePath`, the client doesn't know which instance it connected to until the server tells it. The agent automatically sends its identity on connection:

```typescript
const agent = useAgent({
  agent: "UserAgent",
  basePath: "user",
  onIdentity: (name, agentType) => {
    console.log(`Connected to ${agentType} instance: ${name}`);
    // e.g., "Connected to user-agent instance: user-123"
  }
});

// Reactive state - re-renders when identity is received
return (
  <div>
    {agent.identified ? `Connected to: ${agent.name}` : "Connecting..."}
  </div>
);
```

For `AgentClient`:

```typescript
const agent = new AgentClient({
  agent: "UserAgent",
  basePath: "user",
  host: "example.com",
  onIdentity: (name, agentType) => {
    // Update UI with actual instance name
    setInstanceName(name);
  }
});

// Wait for identity before proceeding
await agent.ready;
console.log(agent.name); // Now has the server-determined name
```

### Handling Identity Changes on Reconnect

If the identity changes on reconnect (e.g., session expired and user logs in as someone else), you can handle it with `onIdentityChange`:

```typescript
const agent = useAgent({
  agent: "UserAgent",
  basePath: "user",
  onIdentityChange: (oldName, newName, oldAgent, newAgent) => {
    console.log(`Session changed: ${oldName} → ${newName}`);
    // Refresh state, show notification, etc.
  }
});
```

If `onIdentityChange` is not provided and identity changes, a warning is logged to help catch unexpected session changes.

### Sub-Paths with `path` Option

Append additional path segments to the URL:

```typescript
// With basePath: /user/settings
useAgent({ agent: "UserAgent", basePath: "user", path: "settings" });

// Standard routing: /agents/my-agent/room/settings
useAgent({ agent: "MyAgent", name: "room", path: "settings" });
```

### Disabling Identity for Security

If your instance names contain sensitive data (session IDs, internal user IDs), you can disable identity sending:

```typescript
class SecureAgent extends Agent {
  // Don't expose instance names to clients
  static options = { sendIdentityOnConnect: false };
}
```

When identity is disabled:

- `agent.identified` stays `false`
- `agent.ready` never resolves (use state updates instead)
- `onIdentity` and `onIdentityChange` are never called

### When to Use Custom Routing

| Scenario                          | Approach                                |
| --------------------------------- | --------------------------------------- |
| Standard agent access             | Default `/agents/{agent}/{name}`        |
| Instance from auth/session        | `basePath` + `getAgentByName` + `fetch` |
| Clean URLs (no `/agents/` prefix) | `basePath` + custom routing             |
| Legacy URL structure              | `basePath` + custom routing             |
| Complex routing logic             | Custom routing in Worker                |

### Request Flow with Custom Routing

```
┌─────────────────┐
│  /user request  │
│  (basePath)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Worker fetch   │
│  getSession()   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ getAgentByName  │
│ (session.userId)│
└────────┬────────┘
         │ agent.fetch(request)
         ▼
┌─────────────────┐
│ Agent Instance  │
│ onConnect() or  │
│ onRequest()     │
└─────────────────┘
```

---

## Server-Side Agent Access

You can access agents from your Worker code using `getAgentByName()` for RPC calls:

```typescript
import { getAgentByName, routeAgentRequest } from "agents";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // API endpoint that interacts with an agent
    if (url.pathname === "/api/increment") {
      const counter = await getAgentByName(env.Counter, "global-counter");
      const newCount = await counter.increment();
      return Response.json({ count: newCount });
    }

    // Regular agent routing
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

### With Location Hints

For latency-sensitive applications, you can hint where the agent should run:

```typescript
const agent = await getAgentByName(env.MyAgent, "instance-name", {
  locationHint: "enam" // Eastern North America
});
```

Available location hints: `wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `oc`, `afr`, `me`

### With Jurisdiction

For data residency requirements:

```typescript
const agent = await getAgentByName(env.MyAgent, "instance-name", {
  jurisdiction: "eu" // EU jurisdiction
});
```

---

## Sub-Paths and HTTP Methods

Requests can include sub-paths after the instance name. These are passed to your agent's `onRequest()` handler:

```
/agents/api/v1/users       → agent: "api", instance: "v1", path: "/users"
/agents/api/v1/users/123   → agent: "api", instance: "v1", path: "/users/123"
```

Handle sub-paths in your agent:

```typescript
export class API extends Agent<Env> {
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // url.pathname contains the full path including /agents/api/v1/...
    // Extract the sub-path after your agent's base path
    const path = url.pathname.replace(/^\/agents\/api\/[^/]+/, "");

    if (request.method === "GET" && path === "/users") {
      return Response.json(await this.getUsers());
    }

    if (request.method === "POST" && path === "/users") {
      const data = await request.json();
      return Response.json(await this.createUser(data));
    }

    return new Response("Not found", { status: 404 });
  }
}
```

---

## Multiple Agents

You can have multiple agent classes in one project. Each gets its own namespace:

```typescript
// server.ts
export { Counter } from "./agents/counter";
export { ChatRoom } from "./agents/chat-room";
export { UserProfile } from "./agents/user-profile";

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

```jsonc
// wrangler.jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "Counter", "class_name": "Counter" },
      { "name": "ChatRoom", "class_name": "ChatRoom" },
      { "name": "UserProfile", "class_name": "UserProfile" }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["Counter", "ChatRoom", "UserProfile"]
    }
  ]
}
```

Each agent is accessed via its own path:

```
/agents/counter/...
/agents/chat-room/...
/agents/user-profile/...
```

---

## Request Flow

Here's how a request flows through the system:

```
┌─────────────────┐
│  HTTP Request   │
│  or WebSocket   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ routeAgentRequest()
│ Parse URL path  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Find binding in │
│ env by name     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Get/create DO   │
│ by instance ID  │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│           Agent Instance            │
├─────────────────────────────────────┤
│ WebSocket? → onConnect(), onMessage()
│ HTTP?      → onRequest()            │
└─────────────────────────────────────┘
```

---

## Routing with Authentication

Check authentication before routing to agents:

```typescript
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Protect agent routes
    if (url.pathname.startsWith("/agents/")) {
      const user = await authenticate(request, env);
      if (!user) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Optionally, enforce that users can only access their own agents
      const instanceName = url.pathname.split("/")[3];
      if (instanceName !== `user-${user.id}`) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

---

## Troubleshooting

### "Agent namespace not found"

The error message lists available agents. Check:

1. Agent class is exported from your entry point
2. Class name in code matches `class_name` in `wrangler.jsonc`
3. URL uses correct kebab-case name

### Request returns 404

1. Verify the URL pattern: `/agents/{agent-name}/{instance-name}`
2. Check that `routeAgentRequest()` is called before your 404 handler
3. Ensure the response from `routeAgentRequest()` is returned (not just called)

### WebSocket won't connect

1. Don't modify the response from `routeAgentRequest()` for WebSocket upgrades
2. Ensure CORS is enabled if connecting from a different origin
3. Check browser dev tools for the actual error

### `basePath` not working

1. Ensure your Worker handles the custom path and forwards to the agent
2. Use `getAgentByName()` + `agent.fetch(request)` to forward requests
3. The `agent` parameter is still required but ignored when `basePath` is set
4. Check that the server-side route matches the client's `basePath`

---

## API Reference

### `routeAgentRequest(request, env, options?)`

Routes a request to the appropriate agent.

| Parameter      | Type                     | Description                     |
| -------------- | ------------------------ | ------------------------------- |
| `request`      | `Request`                | The incoming request            |
| `env`          | `Env`                    | Environment with agent bindings |
| `options.cors` | `boolean \| HeadersInit` | Enable CORS headers             |

**Returns:** `Promise<Response \| undefined>` - Response if matched, undefined if no agent route

### `getAgentByName(namespace, name, options?)`

Get an agent instance by name for server-side RPC or request forwarding.

| Parameter              | Type                        | Description            |
| ---------------------- | --------------------------- | ---------------------- |
| `namespace`            | `DurableObjectNamespace<T>` | Agent binding from env |
| `name`                 | `string`                    | Instance name          |
| `options.locationHint` | `string`                    | Preferred location     |
| `options.jurisdiction` | `string`                    | Data jurisdiction      |

**Returns:** `Promise<DurableObjectStub<T>>` - Typed stub for calling agent methods or forwarding requests

### `useAgent(options)` / `AgentClient` Options

Client connection options:

| Option             | Type                                             | Description                                          |
| ------------------ | ------------------------------------------------ | ---------------------------------------------------- |
| `agent`            | `string`                                         | Agent class name (required)                          |
| `name`             | `string`                                         | Instance name (default: `"default"`)                 |
| `basePath`         | `string`                                         | Full URL path - bypasses agent/name URL construction |
| `path`             | `string`                                         | Additional path to append to the URL                 |
| `onIdentity`       | `(name, agent) => void`                          | Called when server sends identity                    |
| `onIdentityChange` | `(oldName, newName, oldAgent, newAgent) => void` | Called when identity changes on reconnect            |

**Return value properties (React hook):**

| Property     | Type            | Description                                   |
| ------------ | --------------- | --------------------------------------------- |
| `name`       | `string`        | Current instance name (reactive)              |
| `agent`      | `string`        | Current agent class name (reactive)           |
| `identified` | `boolean`       | Whether identity has been received (reactive) |
| `ready`      | `Promise<void>` | Resolves when identity is received            |

### `Agent.options` (Server)

Static options for agent configuration:

| Option                       | Type      | Default | Description                                          |
| ---------------------------- | --------- | ------- | ---------------------------------------------------- |
| `hibernate`                  | `boolean` | `true`  | Whether the agent should hibernate when inactive     |
| `sendIdentityOnConnect`      | `boolean` | `true`  | Whether to send identity to clients on connect       |
| `hungScheduleTimeoutSeconds` | `number`  | `30`    | Timeout before a running schedule is considered hung |

```typescript
class SecureAgent extends Agent {
  static options = { sendIdentityOnConnect: false };
}
```
