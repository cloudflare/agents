# Integrating Agents SDK with Hono

🔥 Hono ⨉ 🧠 Cloudflare Agents

This guide explains how to use the `hono-agents` addon to seamlessly integrate `agents-sdk` agents into Hono applications. With `hono-agents`, you can create persistent AI agents that can think, communicate, and evolve over time, all integrated seamlessly within your Hono application.

## Installation

To get started, install the `hono-agents` package along with its peer dependencies:

```bash
npm install hono-agents hono agents-sdk
```

## Usage

The `agentsMiddleware` function simplifies the integration of agents into your Hono application. Here's how to use it:

### Basic Setup

Import the necessary modules and define your agent classes. These agent classes should extend the `Agent` class from the `agents-sdk`.

```ts
import { Hono } from "hono";
import { agentsMiddleware } from "hono-agents";
import { Agent } from "agents-sdk";

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

export default app;
```

This setup will route all requests (`*`) to the `agentsMiddleware`, which will then determine if the request should be handled by an agent. See [core-agent-functionality.md](core-agent-functionality.md) for more information on how to define agents.

### Authentication

You can add authentication to your agents by using the `onBeforeConnect` option. This allows you to validate a token before upgrading the connection to a WebSocket.

```ts
import { Hono } from "hono";
import { agentsMiddleware } from "hono-agents";
import { Agent } from "agents-sdk";

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

const app = new Hono();
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

export default app;
```

In this example, the `onBeforeConnect` function checks for an `authorization` header and returns a 401 Unauthorized response if the token is missing. You can implement more complex token validation logic within this function.

### Error Handling

The `agentsMiddleware` allows you to specify an `onError` handler to catch any errors that occur during the agent request processing.

```ts
import { Hono } from "hono";
import { agentsMiddleware } from "hono-agents";
import { Agent } from "agents-sdk";

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

const app = new Hono();
app.use("*", agentsMiddleware({ onError: (error) => console.error(error) }));

export default app;
```

This example logs any errors to the console. You can customize the `onError` function to perform more sophisticated error handling, such as sending error reports or returning custom error responses.

### Custom Routing

You can configure the `agentsMiddleware` to only handle requests that match a specific prefix using the `prefix` option.

```ts
import { Hono } from "hono";
import { agentsMiddleware } from "hono-agents";
import { Agent } from "agents-sdk";

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

const app = new Hono();
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

With this configuration, the `agentsMiddleware` will only handle requests that start with `/agents/`. This allows you to isolate agent-related routes from other parts of your Hono application.

## Configuration

To properly configure your Cloudflare Workers project to use agents, update your `wrangler.toml` file. This is necessary to define the Durable Objects that will be used to persist the state of your agents.

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

Replace `ChatAgent` and `AssistantAgent` with the names of your agent classes.

## How It Works

The `agentsMiddleware` function:

1.  Detects whether the incoming request is a WebSocket connection or standard HTTP request.
2.  Routes the request to the appropriate agent.
3.  Handles WebSocket upgrades for persistent connections.
4.  Provides error handling and custom routing options.

Agents can:

- Maintain state across requests
- Handle both HTTP and WebSocket connections
- Schedule tasks for future execution (see [scheduling-tasks-with-agents.md](scheduling-tasks-with-agents.md))
- Communicate with AI services (see [building-ai-chat-agents.md](building-ai-chat-agents.md))
- Integrate seamlessly with React applications (see [react-integration-with-agents-sdk.md](react-integration-with-agents-sdk.md))
