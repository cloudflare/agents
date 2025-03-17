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
  async onRequest(request) {
    return new Response("Ready to assist with chat.");
  }
}

export class AssistantAgent extends Agent {
  async onRequest(request) {
    return new Response("I'm your AI assistant.");
  }
}

// Basic setup
const app = new Hono();
app.use("*", agentsMiddleware());

// or with authentication
app.use(
  "*",
  agentsMiddleware({
    options: {
      onBeforeConnect: async (req) => {
        const token = req.headers.get("authorization");
        // validate token
        if (!token) return new Response("Unauthorized", { status: 401 });
      },
    },
  })
);

// With error handling
app.use("*", agentsMiddleware({ onError: (error) => console.error(error) }));

// With custom routing
app.use(
  "*",
  agentsMiddleware({
    options: {
      prefix: "agents", // Handles /agents/* routes only
    },
  })
);

export default app;
```

## Configuration

To properly configure your Cloudflare Workers project to use agents, update your `wrangler.toml` file:

```toml
[durable_objects]
bindings = [
  { name = "ChatAgent", class_name = "ChatAgent" },
  { name = "AssistantAgent", class_name = "AssistantAgent" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatAgent", "AssistantAgent"]
```

## How It Works

The `agentsMiddleware` function:

1. Detects whether the incoming request is a WebSocket connection or standard HTTP request
2. Routes the request to the appropriate agent
3. Handles WebSocket upgrades for persistent connections
4. Provides error handling and custom routing options

Agents can:

- Maintain state across requests
- Handle both HTTP and WebSocket connections
- Schedule tasks for future execution
- Communicate with AI services
- Integrate seamlessly with React applications

## License

Learn more about Cloudflare Agents at https://www.npmjs.com/package/agents

ISC
