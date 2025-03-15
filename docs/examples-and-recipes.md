# Examples and Recipes

This section provides practical, end-to-end examples and recipes to help you get started with the `agents-sdk`. These examples showcase different types of agents, use cases, communication patterns, and state management techniques.

## Simple Echo Agent

This example demonstrates a basic agent that echoes back the received request.

```typescript
import { Agent } from "agents-sdk";

export class EchoAgent extends Agent {
  async onRequest(request: Request) {
    const text = await request.text();
    return new Response(`You said: ${text}`);
  }
}
```

To deploy this agent, add it to your `wrangler.toml`:

```toml
[durable_objects]
bindings = [
  { name = "EchoAgent", class_name = "EchoAgent" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["EchoAgent"]
```

Now you can send requests to your agent:

```bash
curl "your-agent-url/echo-agent" -d "Hello, Agent!"
```

## Weather API Integration Agent

This example shows how to integrate an agent with an external weather API.

```typescript
import { Agent } from "agents-sdk";

export class WeatherAgent extends Agent {
  async onRequest(request: Request) {
    const url = new URL(request.url);
    const city = url.searchParams.get("city") || "London";
    const apiKey = this.env.WEATHER_API_KEY;

    const weatherData = await fetch(
      `https://api.weatherapi.com/v1/current.json?key=${apiKey}&q=${city}`
    ).then((res) => res.json());

    return new Response(
      `The current weather in ${city} is ${weatherData.current.condition.text}`
    );
  }
}
```

Remember to add `WEATHER_API_KEY` to your environment variables in `wrangler.toml` and configure the Durable Object binding and migration.

```toml
[vars]
WEATHER_API_KEY = "YOUR_WEATHER_API_KEY"

[durable_objects]
bindings = [
  { name = "WeatherAgent", class_name = "WeatherAgent" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["WeatherAgent"]
```

Test the agent with a city parameter:

```bash
curl "your-agent-url/weather-agent?city=Paris"
```

## Basic AI Chatbot Agent

This example demonstrates a simple AI chatbot agent using the `OpenAI` API. See also [building-ai-chat-agents.md](building-ai-chat-agents.md) for more details.

```typescript
import { Agent } from "agents-sdk";
import { OpenAI } from "openai";

export class ChatbotAgent extends Agent {
  async onRequest(request: Request) {
    const ai = new OpenAI({
      apiKey: this.env.OPENAI_API_KEY,
    });

    const prompt = await request.text();

    const response = await ai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
    });

    return new Response(response.choices[0].message.content);
  }
}
```

Configure your `wrangler.toml` with the `OPENAI_API_KEY` and Durable Object settings.

```toml
[vars]
OPENAI_API_KEY = "YOUR_OPENAI_API_KEY"

[durable_objects]
bindings = [
  { name = "ChatbotAgent", class_name = "ChatbotAgent" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatbotAgent"]
```

Send a message to the chatbot:

```bash
curl "your-agent-url/chatbot-agent" -d "What is the capital of France?"
```

## Scheduled Data Analysis Agent

This example shows how to create an agent that performs scheduled data analysis using the `schedule` functionality. See also [scheduling-tasks-with-agents.md](scheduling-tasks-with-agents.md) for more details.

```typescript
import { Agent } from "agents-sdk";

export class DataAnalysisAgent extends Agent {
  async initialize() {
    // Schedule a daily data analysis task
    this.schedule("0 0 * * *", "analyzeData", { reportType: "daily" });
  }

  async analyzeData(payload: { reportType: string }) {
    // Simulate data analysis
    const analysisResult = `Data analysis complete for ${payload.reportType} report.`;
    console.log(analysisResult);
    // You might want to store the analysis result in the agent's state or send it to another service.
  }
}
```

Configure your `wrangler.toml` with the Durable Object settings.

```toml
[durable_objects]
bindings = [
  { name = "DataAnalysisAgent", class_name = "DataAnalysisAgent" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DataAnalysisAgent"]
```

## Communication Patterns

### HTTP Requests

Agents can handle HTTP requests using the `onRequest` method. This allows them to respond to standard web requests.

```typescript
import { Agent } from "agents-sdk";

export class HttpAgent extends Agent {
  async onRequest(request: Request) {
    return new Response("Hello from HTTP Agent!");
  }
}
```

### WebSockets

Agents can also handle WebSocket connections, enabling real-time communication. See also [core-agent-functionality.md](core-agent-functionality.md) for more details.

```typescript
import { Agent, Connection } from "agents-sdk";

export class WebSocketAgent extends Agent {
  async onConnect(connection: Connection) {
    connection.send("Welcome to the WebSocket Agent!");
  }

  async onMessage(connection: Connection, message: any) {
    connection.send(`You sent: ${message}`);
  }
}
```

### Agent to Agent Communication

Agents can communicate with each other by making HTTP requests to each other's endpoints. You can use `agentFetch` from the `agents-sdk/client` to make these requests. See also [core-agent-functionality.md](core-agent-functionality.md) for more details.

```typescript
import { Agent } from "agents-sdk";
import { agentFetch } from "agents-sdk/client";

export class AgentA extends Agent {
  async onRequest(request: Request) {
    const response = await agentFetch(
      {
        agent: "AgentB",
        name: "default", // or the name of a specific AgentB instance
      },
      {
        method: "POST",
        body: "Hello from AgentA!",
      }
    );

    const message = await response.text();
    return new Response(`AgentB says: ${message}`);
  }
}

export class AgentB extends Agent {
  async onRequest(request: Request) {
    const message = await request.text();
    return new Response(`AgentB received: ${message}`);
  }
}
```

## State Management Techniques

### Using `this.state`

Agents can maintain state across requests using the `this.state` property. See also [core-agent-functionality.md](core-agent-functionality.md) for more details.

```typescript
import { Agent } from "agents-sdk";

export class CounterAgent extends Agent {
  initialState = { count: 0 };

  async onRequest(request: Request) {
    this.setState({ count: this.state.count + 1 });
    return new Response(`Count: ${this.state.count}`);
  }
}
```

### Using Durable Storage

Agents can also use Durable Objects storage to persist data. This is useful for storing larger amounts of data or data that needs to be shared between agents.

```typescript
import { Agent } from "agents-sdk";

export class StorageAgent extends Agent {
  async onRequest(request: Request) {
    const key = "myKey";
    const value = (await this.ctx.storage.get(key)) || 0;
    await this.ctx.storage.put(key, value + 1);
    return new Response(`Value: ${value + 1}`);
  }
}
```

These examples provide a starting point for building your own intelligent agents with the `agents-sdk`. Experiment with different combinations of these techniques to create powerful and versatile agents for your applications.
