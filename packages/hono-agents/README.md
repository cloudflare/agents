# hono-agents

🔥 Hono ⨉ 🧠 Cloudflare Agents

Add intelligent, stateful AI agents to your Hono app. Create persistent AI agents that can think, communicate, and evolve over time, all integrated seamlessly with your Hono application.

## Installation

```bash
npm install agents hono hono-agents
```

## Usage

```ts
import { Hono } from "hono";
import { Agent } from "agents";
import { agentsMiddleware } from "hono-agents";

// Define your agent classes
export class ChatAgent extends Agent {
  async onRequest(_request: Request) {
    return new Response("Ready to assist with chat.");
  }
}

export class AssistantAgent extends Agent {
  async onRequest(_request: Request) {
    return new Response("I'm your AI assistant.");
  }
}

// Basic setup
const app = new Hono();
app.use("*", agentsMiddleware());

export default app;
```

### Authentication

Replace the basic middleware registration with one that authenticates both
WebSocket connections and HTTP requests:

```ts
const authorizeAgentRequest = async (req: Request) => {
  const token = req.headers.get("authorization");
  // Validate token
  if (!token) return new Response("Unauthorized", { status: 401 });
};

app.use(
  "*",
  agentsMiddleware({
    options: {
      onBeforeConnect: authorizeAgentRequest,
      onBeforeRequest: authorizeAgentRequest
    }
  })
);
```

### Error handling

Replace the basic middleware registration to add an error handler:

```ts
app.use("*", agentsMiddleware({ onError: (error) => console.error(error) }));
```

### Custom routing

Replace the basic middleware registration to customize routing:

```ts
app.use(
  "*",
  agentsMiddleware({
    options: {
      prefix: "agents" // Handles /agents/* routes only
    }
  })
);
```

## Configuration

To properly configure your Cloudflare Workers project to use agents, add bindings to your `wrangler.jsonc` file:

```json
{
  "durable_objects": {
    "bindings": [
      { "name": "ChatAgent", "class_name": "ChatAgent" },
      { "name": "AssistantAgent", "class_name": "AssistantAgent" }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["ChatAgent", "AssistantAgent"]
    }
  ]
}
```

## How It Works

The `agentsMiddleware` function:

1. Detects whether the incoming request is a WebSocket connection or standard HTTP request
2. Routes the request to the appropriate agent
3. Handles WebSocket upgrades for persistent connections
4. Provides error handling and custom routing options

Requests that do not match an Agent route continue through later Hono middleware
and routes. Once an Agent route matches, its response—including an HTTP
rejection—is returned without invoking later handlers. Mount `agentsMiddleware`
on a narrower path or configure a distinct prefix if the app has other WebSocket
routes under the same URL prefix.

Agents can:

- Maintain state across requests
- Handle both HTTP and WebSocket connections
- Schedule tasks for future execution
- Communicate with AI services
- Integrate seamlessly with React applications

## License

Learn more about Cloudflare Agents at https://www.npmjs.com/package/agents

ISC
