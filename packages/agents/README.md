### 🧠 `@cloudflare/agents` - A Framework for Digital Intelligence

Welcome to a new chapter in software development, where AI agents persist, think, and act with purpose. The `@cloudflare/agents` framework creates an environment where artificial intelligence can flourish - maintaining state, engaging in meaningful interactions, and evolving over time.

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
npm create cloudflare@latest -- --template agents

# Or enhance an existing one
npm install @cloudflare/agents
```

### 📝 Your First Agent

Create an agent that bridges thought and action:

```ts
import { Agent } from "@cloudflare/agents";

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
import { Agent } from "@cloudflare/agents";
import { OpenAI } from "openai";

export class AIAgent extends Agent {
  async onRequest(request) {
    // Connect with AI capabilities
    const ai = new OpenAI();

    // Process and understand
    const response = await ai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: await request.text() }],
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
        "binding": "AIAgent",
        "class_name": "AIAgent"
      }
    ]
  }
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
  parameters: initialConfig,
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

    return new Response(
      JSON.stringify({
        insight: await this.process(data),
        moment: Date.now(),
      })
    );
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

#### Client Communion

For direct connection to your agent:

```ts
import { AgentClient } from "@cloudflare/agents/client";

const connection = new AgentClient({
  agent: "dialogue-agent",
  name: "insight-seeker",
});

connection.addEventListener("message", (event) => {
  console.log("Received:", event.data);
});

connection.send(
  JSON.stringify({
    type: "inquiry",
    content: "What patterns do you see?",
  })
);
```

#### React Integration

For harmonious integration with React:

```tsx
import { useAgent } from "@cloudflare/agents/react";

function AgentInterface() {
  const connection = useAgent({
    agent: "dialogue-agent",
    name: "insight-seeker",
    onMessage: (message) => {
      console.log("Understanding received:", message.data);
    },
    onOpen: () => console.log("Connection established"),
    onClose: () => console.log("Connection closed"),
  });

  const inquire = () => {
    connection.send(
      JSON.stringify({
        type: "inquiry",
        content: "What insights have you gathered?",
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
      understanding: this.state.understanding + 1,
    });
  }

  onStateUpdate(state, source) {
    console.log("Understanding deepened:", {
      newState: state,
      origin: source,
    });
  }
}
```

### ⏳ Temporal Patterns

Schedule moments of action and reflection:

```ts
export class TimeAwareAgent extends Agent {
  async initialize() {
    // Quick reflection
    this.schedule(10, "quickInsight", { focus: "patterns" });

    // Daily synthesis
    this.schedule("0 0 * * *", "dailySynthesis", {
      depth: "comprehensive",
    });

    // Milestone review
    this.schedule(new Date("2024-12-31"), "yearlyAnalysis");
  }

  async quickInsight(data) {
    await this.analyze(data.focus);
  }
}
```

### 💬 AI Dialogue

Create meaningful conversations with intelligence:

```ts
import { AIChatAgent } from "@cloudflare/agents/ai-chat-agent";
import { createOpenAI } from "@ai-sdk/openai";

export class DialogueAgent extends AIChatAgent {
  async onChatMessage(connection, messages, onFinish) {
    return createDataStreamResponse({
      execute: async (dataStream) => {
        const ai = createOpenAI({
          apiKey: this.env.OPENAI_API_KEY,
        });

        const stream = streamText({
          model: ai("gpt-4"),
          messages,
          onFinish,
        });

        stream.mergeIntoDataStream(dataStream);
      },
    });
  }
}
```

### 🌅 The Path Forward

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
