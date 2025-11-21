### 🧠 `agents` - A Framework for Digital Intelligence

![npm install agents](../../assets/npm-install-agents.svg)

Welcome to a new chapter in software development, where AI agents persist, think, and act with purpose. The `agents` framework creates an environment where artificial intelligence can flourish - maintaining state, engaging in meaningful interactions, and evolving over time.

_This project is in active development. Join us in shaping the future of intelligent agents._

#### The Nature of Agents

An AI agent transcends traditional software boundaries. It's an entity that:

- **Persistence**: Maintains its state and knowledge across time
- **Agency**: Acts autonomously within its defined purpose
- **Connection**: Communicates through multiple channels with both humans and other agents
- **Growth**: Learns and adapts through its interactions

Built on Cloudflare's global network, this framework provides agents with a reliable, distributed foundation where they can operate continuously and effectively.

#### 💫 Core Principles

1. **Stateful Existence**: Each agent maintains its own persistent reality
2. **Long-lived Presence**: Agents can run for extended periods, resting when idle
3. **Natural Communication**: Interact through HTTP, WebSockets, or direct calls
4. **Global Distribution**: Leverage Cloudflare's network for worldwide presence
5. **Resource Harmony**: Efficient hibernation and awakening as needed

---

### 🌱 Beginning the Journey

Start with a complete environment:

```sh
# Create a new project
npm create cloudflare@latest -- --template cloudflare/agents-starter

# Or enhance an existing one
npm install agents
```

### 📝 Your First Agent

Create an agent that bridges thought and action:

```ts
import { Agent } from "agents";

export class IntelligentAgent extends Agent {
  async onRequest(request) {
    // Transform intention into response
    return new Response("Ready to assist.");
  }
}
```

### 🎭 Patterns of Intelligence

Agents can manifest various forms of understanding:

```ts
import { Agent } from "agents";
import { OpenAI } from "openai";

export class AIAgent extends Agent {
  async onRequest(request) {
    // Connect with AI capabilities
    const ai = new OpenAI({
      apiKey: this.env.OPENAI_API_KEY
    });

    // Process and understand
    const response = await ai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: await request.text() }]
    });

    return new Response(response.choices[0].message.content);
  }

  async processTask(task) {
    await this.understand(task);
    await this.act();
    await this.reflect();
  }
}
```

### 🏰 Creating Space

Define your agent's domain:

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "AIAgent",
        "class_name": "AIAgent"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      // Mandatory for the Agent to store state
      "new_sqlite_classes": ["AIAgent"]
    }
  ]
}
```

### 🌐 Lifecycle

Bring your agent into being:

```ts
// Create a new instance
const id = env.AIAgent.newUniqueId();
const agent = env.AIAgent.get(id);

// Initialize with purpose
await agent.processTask({
  type: "analysis",
  context: "incoming_data",
  parameters: initialConfig
});

// Or reconnect with an existing one
const existingAgent = await getAgentByName(env.AIAgent, "data-analyzer");
```

### 🔄 Paths of Communication

#### HTTP Understanding

Process and respond to direct requests:

```ts
export class APIAgent extends Agent {
  async onRequest(request) {
    const data = await request.json();

    return Response.json({
      insight: await this.process(data),
      moment: Date.now()
    });
  }
}
```

#### Persistent Connections

Maintain ongoing dialogues through WebSocket:

```ts
export class DialogueAgent extends Agent {
  async onConnect(connection) {
    await this.initiate(connection);
  }

  async onMessage(connection, message) {
    const understanding = await this.comprehend(message);
    await this.respond(connection, understanding);
  }
}
```

#### Client Communication

For direct connection to your agent:

```ts
import { AgentClient } from "agents/client";

const connection = new AgentClient({
  agent: "dialogue-agent",
  name: "insight-seeker"
});

connection.addEventListener("message", (event) => {
  console.log("Received:", event.data);
});

connection.send(
  JSON.stringify({
    type: "inquiry",
    content: "What patterns do you see?"
  })
);
```

#### React Integration

For harmonious integration with React:

```tsx
import { useAgent } from "agents/react";

function AgentInterface() {
  const connection = useAgent({
    agent: "dialogue-agent",
    name: "insight-seeker",
    onMessage: (message) => {
      console.log("Understanding received:", message.data);
    },
    onOpen: () => console.log("Connection established"),
    onClose: () => console.log("Connection closed")
  });

  const inquire = () => {
    connection.send(
      JSON.stringify({
        type: "inquiry",
        content: "What insights have you gathered?"
      })
    );
  };

  return (
    <div className="agent-interface">
      <button onClick={inquire}>Seek Understanding</button>
    </div>
  );
}
```

### 🌊 Flow of State

Maintain and evolve your agent's understanding:

```ts
export class ThinkingAgent extends Agent {
  async evolve(newInsight) {
    this.setState({
      ...this.state,
      insights: [...(this.state.insights || []), newInsight],
      understanding: this.state.understanding + 1
    });
  }

  onStateUpdate(state, source) {
    console.log("Understanding deepened:", {
      newState: state,
      origin: source
    });
  }
}
```

Connect to your agent's state from React:

```tsx
import { useState } from "react";
import { useAgent } from "agents/react";

function StateInterface() {
  const [state, setState] = useState({ counter: 0 });

  const agent = useAgent({
    agent: "thinking-agent",
    onStateUpdate: (newState) => setState(newState)
  });

  const increment = () => {
    agent.setState({ counter: state.counter + 1 });
  };

  return (
    <div>
      <div>Count: {state.counter}</div>
      <button onClick={increment}>Increment</button>
    </div>
  );
}
```

This creates a synchronized state that automatically updates across all connected clients.

### ⏳ Temporal Patterns

Schedule moments of action and reflection:

```ts
export class TimeAwareAgent extends Agent {
  async initialize() {
    // Quick reflection
    this.schedule(10, "quickInsight", { focus: "patterns" });

    // Daily synthesis
    this.schedule("0 0 * * *", "dailySynthesis", {
      depth: "comprehensive"
    });

    // Milestone review
    this.schedule(new Date("2024-12-31"), "yearlyAnalysis");
  }

  async quickInsight(data) {
    await this.analyze(data.focus);
  }

  async dailySynthesis(data) {
    await this.synthesize(data.depth);
  }

  async yearlyAnalysis() {
    await this.analyze();
  }
}
```

### 💬 AI Dialogue

Create meaningful conversations with intelligence:

```ts
import { AIChatAgent } from "agents/ai-chat-agent";
import { openai } from "@ai-sdk/openai";
import { streamText, generateText, createDataStreamResponse } from "ai";

export class DialogueAgent extends AIChatAgent {
  async onChatMessage(onFinish) {
    // Option 1: Streaming responses (recommended for real-time interaction)
    return createDataStreamResponse({
      execute: async (dataStream) => {
        const stream = streamText({
          model: openai("gpt-4o"),
          messages: this.messages,
          // Optional: onFinish is invoked by the AI SDK when generation completes.
          // Persistence is handled automatically by AIChatAgent after streaming completes.
          onFinish
        });

        stream.mergeIntoDataStream(dataStream);
      }
    });

    // Option 2: Non-streaming responses (simpler, but no real-time updates)
    // const result = await generateText({
    //   model: openai("gpt-4o"),
    //   messages: this.messages,
    // });
    //
    // // For non-streaming with metadata, use toUIMessage:
    // const message = result.toUIMessage({
    //   metadata: {
    //     model: 'gpt-4o',
    //     totalTokens: result.usage?.totalTokens,
    //   }
    // });
    //
    // return new Response(JSON.stringify(message), {
    //   headers: { 'Content-Type': 'application/json' }
    // });
  }
}
```

#### Metadata Support

The AI SDK provides native support for message metadata through the `messageMetadata` callback. This allows you to attach custom information to messages at the message level.

##### AIChatAgent Integration

In the context of `AIChatAgent`, you can use metadata like this:

```typescript
import { AIChatAgent } from "agents/ai-chat-agent";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

export class MyAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish) {
    const startTime = Date.now();

    const result = streamText({
      model: openai("gpt-4o"),
      messages: this.messages,
      onFinish
    });

    return result.toUIMessageStreamResponse({
      messageMetadata: ({ part }) => {
        if (part.type === "start") {
          return {
            model: "gpt-4o",
            createdAt: Date.now(),
            messageCount: this.messages.length
          };
        }
        if (part.type === "finish") {
          return {
            responseTime: Date.now() - startTime,
            totalTokens: part.totalUsage?.totalTokens
          };
        }
      }
    });
  }
}
```

##### Accessing Metadata on the Client

Access metadata through the `message.metadata` property:

```typescript
'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import type { MyUIMessage } from '@/types';

export default function Chat() {
  const { messages } = useChat<MyUIMessage>({
    transport: new DefaultChatTransport({
      api: '/api/chat',
    }),
  });

  return (
    <div>
      {messages.map(message => (
        <div key={message.id}>
          <div>
            {message.role === 'user' ? 'User: ' : 'AI: '}
            {message.metadata?.createdAt && (
              <span className="text-sm text-gray-500">
                {new Date(message.metadata.createdAt).toLocaleTimeString()}
              </span>
            )}
          </div>
          {/* Render message content */}
          {message.parts.map((part, index) =>
            part.type === 'text' ? <div key={index}>{part.text}</div> : null,
          )}
          {/* Display additional metadata */}
          {message.metadata?.totalTokens && (
            <div className="text-xs text-gray-400">
              {message.metadata.totalTokens} tokens
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

For more details, see the [AI SDK Message Metadata documentation](https://ai-sdk.dev/docs/ai-sdk-ui/message-metadata).

#### Creating the Interface

Connect with your agent through a React interface:

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "agents/ai-react";

function ChatInterface() {
  // Connect to the agent
  const agent = useAgent({
    agent: "dialogue-agent"
  });

  // Set up the chat interaction
  const { messages, input, handleInputChange, handleSubmit, clearHistory } =
    useAgentChat({
      agent,
      maxSteps: 5
    });

  return (
    <div className="chat-interface">
      {/* Message History */}
      <div className="message-flow">
        {messages.map((message) => (
          <div key={message.id} className="message">
            <div className="role">{message.role}</div>
            <div className="content">
              {message.parts.map((part, i) => {
                if (part.type === "text")
                  return <span key={i}>{part.text}</span>;
                // Render other part types (e.g., files, tool calls) as desired
                return null;
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Input Area */}
      <form onSubmit={handleSubmit} className="input-area">
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Type your message..."
          className="message-input"
        />
      </form>

      <button onClick={clearHistory} className="clear-button">
        Clear Chat
      </button>
    </div>
  );
}
```

This creates:

- Real-time message streaming
- Simple message history
- Intuitive input handling
- Easy conversation reset

### 🔗 MCP (Model Context Protocol) Integration

Agents can seamlessly integrate with the Model Context Protocol, allowing them to act as both MCP servers (providing tools to AI assistants) and MCP clients (using tools from other services).

#### Creating an MCP Server

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

type Env = {
  MyMCP: DurableObjectNamespace<MyMCP>;
};

type State = { counter: number };

export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({
    name: "Demo",
    version: "1.0.0"
  });

  initialState: State = {
    counter: 1
  };

  async init() {
    this.server.resource("counter", "mcp://resource/counter", (uri) => {
      return {
        contents: [{ text: String(this.state.counter), uri: uri.href }]
      };
    });

    this.server.registerTool(
      "add",
      {
        description: "Add to the counter, stored in the MCP",
        inputSchema: { a: z.number() }
      },
      async ({ a }) => {
        this.setState({ ...this.state, counter: this.state.counter + a });

        return {
          content: [
            {
              text: String(`Added ${a}, total is now ${this.state.counter}`),
              type: "text"
            }
          ]
        };
      }
    );
  }

  onStateUpdate(state: State) {
    console.log({ stateUpdate: state });
  }
}

// HTTP Streamable transport (recommended)
export default MyMCP.serve("/mcp", {
  binding: "MyMCP"
});

// Or SSE transport for legacy compatibility
// export default MyMCP.serveSSE("/mcp", { binding: "MyMCP" });
```

#### Using MCP Tools

```typescript
import { MCPClientManager } from "agents/mcp";

const client = new MCPClientManager("my-app", "1.0.0");

// Connect to an MCP server
await client.connect("https://weather-service.com/mcp", {
  transport: { type: "streamable-http" }
});

// Use tools from the server
const weather = await client.callTool({
  serverId: "weather-service",
  name: "getWeather",
  arguments: { location: "San Francisco" }
});
```

#### AI SDK Integration

```typescript
import { generateText } from "ai";

// Convert MCP tools for AI use
const result = await generateText({
  model: openai("gpt-4"),
  tools: client.getAITools(),
  prompt: "What's the weather in Tokyo?"
});
```

**Transport Options:**

- **Auto**: Automatically determine the correct transport
- **HTTP Streamable**: Best performance, batch requests, session management
- **SSE**: Simple setup, legacy compatibility

### 💬 The Path Forward

We're developing new dimensions of agent capability:

#### Enhanced Understanding

- **WebRTC Perception**: Audio and video communication channels
- **Email Discourse**: Automated email interaction and response
- **Deep Memory**: Long-term context and relationship understanding

#### Development Insights

- **Evaluation Framework**: Understanding agent effectiveness
- **Clear Sight**: Deep visibility into agent processes
- **Private Realms**: Complete self-hosting guide

These capabilities will expand your agents' potential while maintaining their reliability and purpose.

Welcome to the future of intelligent agents. Create something meaningful. 🌟

### Contributing

Contributions are welcome, but are especially welcome when:

- You have opened an issue as a Request for Comment (RFC) to discuss your proposal, show your thinking, and iterate together.
- Not "AI slop": LLMs are powerful tools, but contributions entirely authored by vibe coding are unlikely to meet the quality bar, and will be rejected.
- You're willing to accept feedback and make sure the changes fit the goals of the `agents` SDK. Not everything will, and that's OK.

Small fixes, type bugs, and documentation improvements can be raised directly as PRs.

### License

MIT licensed. See the LICENSE file at the root of this repository for details.
