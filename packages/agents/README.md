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

The examples below use `@callable()` decorators. Vite projects must extend
`agents/tsconfig` and add the `agents/vite` plugin; other bundlers must support
TC39 decorators (`2023-11`). See
[Adding Agents to an Existing Project](../../docs/agents/adding-to-existing-project.md#4-configure-typescript-and-vite).

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

export type State = { count: number };

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
import type { CounterAgent, State } from "./server";

function Counter() {
  const [count, setCount] = useState(0);

  const agent = useAgent<CounterAgent, State>({
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
Core         State sync · Routing · HTTP & WebSockets · @callable RPC · Sub-agents (facets)
Clients      React hook · Vanilla JS · Real-time state sync
Channels     WebSocket · HTTP · Email · Voice · Slack · Telegram
Background   Queue · Scheduling · Managed fibers · Workflows · Human-in-the-loop
AI           Chat agents · Agent tools · Tool calling · MCP servers & clients
Platform     Observability · Cross-domain auth · Resumable streams
```

### Voice and messaging channels

Voice and provider-neutral messaging use separate entry points so applications
only load the integrations they import:

```typescript
import { withVoice } from "agents/voice";
import { VoiceClient } from "agents/voice/client";
import { useVoiceAgent } from "agents/voice/react";

import { ChannelHost } from "agents/channels";
import { email } from "agents/channels/email";
import { slack } from "agents/channels/slack";
import { telegram } from "agents/channels/telegram";
import { web } from "agents/channels/web";
```

See the [Voice](../../docs/agents/voice.md) and
[Channels](../../docs/agents/channels.md) references.

Slack and Telegram can include tool status and provider-exposed reasoning in a
streamed message:

```typescript
const slackChannel = slack({
  botToken: env.SLACK_BOT_TOKEN,
  renderParts: { tools: true, reasoning: true }
});
const telegramChannel = telegram({
  botToken: env.TELEGRAM_BOT_TOKEN,
  renderParts: { tools: true, reasoning: true }
});
```

Tool inputs and outputs are never included. Slack shows tools by default to
preserve its existing task updates. Telegram hides tools by default, and both
Channels hide reasoning unless it is enabled explicitly.

### Durable response streams

A `ChannelHost` can record its neutral `ChannelChunk` stream before delivery.
Install the same `Streams` capability on the Durable Object and pass it to the
Host:

```typescript
import { ChannelHost } from "agents/channels";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";

readonly streams = new Streams();
readonly channels = new ChannelHost({
  channels: { slack: this.slack },
  streams: this.streams
});
readonly lifecycle = Lifecycle.install(this).use(this.streams);
```

Each streamed response then supplies stable application identities:

```typescript
await this.channels.stream(surface, chunks, {
  response: {
    id: responseId,
    conversationId,
    messageId: assistantMessageId
  }
});
```

The Host inserts or validates the opening message ID, assigns stable IDs and
boundaries to implicit parts, durably appends every chunk before the Channel
receives it, and settles the response stream with its source.
`Streams.read(responseId)` can replay the recorded prefix and follow a live
tail. Use one response ID per assistant response attempt. Transcript
snapshots remain application-owned conversation state rather than a derived
view of temporary response logs.

### Web chat on a Durable Object

The Web Channel speaks the existing browser chat protocol without requiring an
Agent subclass. Install its WebSockets capability separately:

```typescript
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { ChannelHost } from "agents/channels";
import { web } from "agents/channels/web";
import { Streams } from "agents/streams";

export class Conversation extends DurableObject {
  readonly streams = new Streams();
  readonly web = web({
    resolveIdentity(request) {
      // These values must come from authenticated request data.
      const url = new URL(request.url);
      return {
        conversationId: url.searchParams.get("conversationId")!,
        participantId: url.searchParams.get("participantId")!
      };
    }
  });
  readonly channels: ChannelHost = new ChannelHost({
    channels: { web: this.web },
    streams: this.streams,
    async resolveMessages({ conversationId }) {
      return {
        messages: await loadConversationMessages(conversationId)
      };
    },
    onMessage: async ({ message }) => {
      if (!message.replySurface) return;
      await this.channels.deliver(message.replySurface, {
        markdown: `You said: ${message.message.text}`
      });
    },
    async onApprovalResponse({ response }) {
      await applyApproval(
        response.interactionId,
        response.decision,
        response.actor
      );
    },
    async onCancel({ request }) {
      await cancelOperation(request.operationId);
    },
    async onConversationReset({ request }) {
      await clearConversationMessages(request.thread.id);
    }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.web.webSockets);

  async onRequest(request: Request) {
    return (
      (await this.channels.handleRequest(request)) ??
      new Response("Not found", { status: 404 })
    );
  }
}
```

Route authenticated upgrade and `/get-messages` requests to this object from
your Worker. The `onRequest` forwarding above lets the default `useAgentChat`
loader obtain the same participant-filtered canonical snapshot that Web sends
when a socket connects. Use
`channels.stream(replySurface, chunks, { response })` for progressive output,
including rich shared `ChannelChunk` events. Supply one stable response ID per
attempt plus its conversation and canonical assistant-message IDs, as shown in
the durable response-stream section above. The client can use
`WebSocketChatTransport` from `agents/chat/transport`.

Explicit browser cancellation immediately stops matching Web delivery and then
calls `onCancel` with the same opaque `operationId` exposed on the initiating
message or continuation event. The application uses that callback to stop model
or task execution. Clear calls `onConversationReset`; only after the application
finishes its own reset policy does Web acknowledge and broadcast the clear. The
application should remove both canonical messages and any durable response logs
that its reset policy considers part of the conversation.

Interactive approvals use the same transport-neutral interface as every other
Channel: call `channels.requestApproval(surface, options)`, then handle the
participant's decision in `onApprovalResponse`. Client tool definitions and
results route through `onMessage` and `onToolResult`. An `autoContinue` value is
advisory; the application decides when all results or approvals are ready and
starts any continuation through `channels.stream()`. Returning from one callback
without streaming leaves that continuation pending so another outstanding result
can complete the turn; the application must eventually stream or cancel the
operation. Web owns only the existing resume offer/ack mechanics.

Connections resolved to the same conversation receive full canonical history
snapshots when they connect and when the application admits a user message. The
application returns transport-neutral messages from `resolveMessages`; the Web
Channel projects their `ChannelChunk` content into browser messages. It keeps a
transient admitted-message overlay while canonical storage catches up. Ordinary
assistant output streams to every live conversation connection. After streaming,
the Channel broadcasts a reconciliation snapshot only when canonical history
contains the completed assistant message. Browser client tools can be marked for
one participant with a chunk `audience`, so another participant's snapshot does
not expose them.

When Streams are configured, the Web Channel discovers the latest response for
the conversation during the existing resume request/ACK handshake. It replays
the neutral durable chunks through the Web projection, then tails new chunks
without switching to a second live-delivery path. Browser-local tool chunks are
replayed only to their initiating participant. A settled response already
present in the canonical transcript is not replayed again.

Incoming `cf_agent_chat_messages` frames are deliberately ignored. They are a
lossy browser projection produced by `useAgentChat.setMessages()`, not an
authoritative replacement for application storage. Set
`syncMessagesToServer: false` when using server-authoritative Channel history.

The capability claims ordinary WebSocket upgrades on the object; do not combine
it with another plain-WebSocket handler that owns the same requests.

See the [live test instructions](./src/channels/live-tests/README.md) for the
bare Durable Object fixture and shared provider scenarios.

### State Management

State persists across requests and syncs to all connected clients:

```typescript
import { Agent, callable, type Connection } from "agents";

type State = { items: string[] };

export class MyAgent extends Agent<Env, State> {
  initialState: State = { items: [] };

  @callable()
  addItem(item: string) {
    this.setState({ items: [...this.state.items, item] });
  }

  onStateChanged(state: State, source: Connection | "server") {
    // Called after state is persisted and broadcast
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

### Sub-agents

Spawn child Durable Objects (facets) from a parent agent. Each child has
its own SQLite storage and runs in parallel, but is addressed under the
parent's URL:

```typescript
export class Inbox extends Agent {
  @callable()
  async createChat() {
    const id = crypto.randomUUID();
    await this.subAgent(Chat, id);
    return id;
  }

  override async onBeforeSubAgent(_req, { className, name }) {
    if (!this.hasSubAgent(className, name)) {
      return new Response("Not found", { status: 404 });
    }
  }
}

export class Chat extends Agent {
  async writePreview(text: string) {
    const inbox = await this.parentAgent(Inbox);
    await inbox.savePreview(this.name, text);
  }
}
```

Client-side, connect to a child with `useAgent({ sub: [...] })`:

```tsx
const inbox = useAgent({ agent: "Inbox", name: userId });
const chat = useAgent({
  agent: "Inbox",
  name: userId,
  sub: [{ agent: "Chat", name: chatId }]
});
```

The routed URL becomes `/agents/inbox/{userId}/sub/chat/{chatId}`.

Child WebSocket clients can use the same URL shape. The parent remains the
public address, while child agents still receive `onConnect`, `onMessage`,
`onClose`, `broadcast()`, and `getConnections()` calls scoped to their own
clients. Parent broadcasts do not leak to child-targeted sockets, and child
connection tags, readonly state, and protocol-message settings are preserved
when a connection is resumed from hibernation.

Nested sub-agent URLs are supported using repeated `/sub/{agent}/{name}`
segments, subject to the platform's current facet nesting limits.

### Agent Tools

Run chat-capable sub-agents as tools from a parent chat agent. Think agents and
`AIChatAgent` subclasses are supported. The child keeps its own messages, tools,
SQLite storage, and resumable stream, while the parent broadcasts
`agent-tool-event` frames so the UI can render the child timeline inline.

```typescript
import { Think } from "@cloudflare/think";
import { agentTool } from "agents/agent-tools";
import { z } from "zod";

export class Researcher extends Think<Env> {
  getSystemPrompt() {
    return "Research the requested topic and end with a concise summary.";
  }
}

export class Assistant extends Think<Env> {
  getTools() {
    return {
      research: agentTool(Researcher, {
        description: "Research one topic in depth.",
        inputSchema: z.object({ query: z.string().min(3) })
      })
    };
  }
}
```

`inputSchema` accepts schemas supported by the AI SDK, including Zod, Standard
JSON Schema-compatible schemas, raw JSON Schema through `jsonSchema()`, and
schemas exposed through AI SDK adapters. For example, use `@ai-sdk/valibot` v2
with AI SDK 6 or v3 with AI SDK 7:

```typescript
import { valibotSchema } from "@ai-sdk/valibot";
import * as v from "valibot";

const researchInput = valibotSchema(
  v.object({ query: v.pipe(v.string(), v.minLength(3)) })
);

agentTool(Researcher, {
  description: "Research one topic in depth.",
  inputSchema: researchInput
});
```

Tool inputs need model-facing JSON Schema in addition to runtime validation. A
validation-only Standard Schema is therefore insufficient; use its Standard
JSON Schema extension or an AI SDK adapter.

For deterministic fan-out, call `this.runAgentTool(Researcher, { input })`
directly. Parent recovery reconciles stale child rows after restarts and marks
unrecoverable runs `interrupted` instead of hanging. In React, use
`useAgentToolEvents({ agent })` to render retained and replayed child timelines.
AIChatAgent children run headlessly, so browser client tools require a separate
bridge; server-side tools work normally. See the full
[Agent Tools guide](../../docs/agents/agent-tools.md).

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
import type { AgentEmail } from "agents/email";

async onEmail(email: AgentEmail) {
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

See [Workflows](../../docs/agents/workflows.md) and [Human in the Loop](../../docs/agents/human-in-the-loop.md).

---

## AI Chat Integration

For AI-powered chat experiences with persistent conversations, streaming responses, and tool support, see [`@cloudflare/ai-chat`](../ai-chat/README.md).

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { convertToModelMessages, streamText } from "ai";

export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.7-code"),
      messages: await convertToModelMessages(this.messages)
    });

    return result.toUIMessageStreamResponse();
  }
}
```

```tsx
// Client
import { useAgentChat } from "@cloudflare/ai-chat/react";

const { messages, sendMessage } = useAgentChat({
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

### Creating a Stateless MCP server

```typescript
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
  const server = new McpServer({ name: "my-tools", version: "1.0.0" });
  server.registerTool(
    "lookup",
    { description: "Look up data", inputSchema: { query: z.string() } },
    async ({ query }) => ({
      content: [{ type: "text", text: await lookup(query) }]
    })
  );
  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(createServer)(request, env, ctx);
  }
} satisfies ExportedHandler;
```

Use `McpAgent`, `createLegacyMcpHandler`, and `WorkerTransport` from
`agents/mcp` only when retaining Legacy session behavior.

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
  tools: this.mcp.getAITools(),
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

The published package includes the complete documentation tree at
`docs/index.md`.

[Getting Started](../../docs/agents/getting-started.md) ·
[State Management](../../docs/agents/state.md) ·
[Scheduling](../../docs/agents/scheduling.md) ·
[Callable Methods](../../docs/agents/callable-methods.md) ·
[Durable Object Lifecycle](../../docs/agents/lifecycle.md) ·
[MCP Integration](../../docs/agents/mcp-client.md) ·
[Full Documentation](../../docs/agents/index.md)

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
