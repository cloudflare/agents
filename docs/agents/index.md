# Agents Documentation

Build stateful AI agents on Cloudflare Workers. An agent is a Durable Object: an addressable actor with its own SQLite database, alarms, and WebSockets. You can run one durable agent per user, account, task, or conversation, and pay close to nothing while it is idle.

Every agent starts the same way. Extend `DurableObject`, install a [Lifecycle](./lifecycle.md), and add the capabilities you need:

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { MCPClientManager } from "agents/mcp/client";
import { Scheduler } from "agents/schedules";

export class Assistant extends DurableObject<Env> {
  readonly mcp = new MCPClientManager("assistant", "1.0.0");
  readonly scheduler = new Scheduler({ callbacks: {} });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.mcp)
    .use(this.scheduler);
}
```

The Lifecycle runs startup, routes requests to capabilities, and owns the object's durable job queue and its single alarm. Capabilities are independent pieces that share it.

## Related package documentation

- `@cloudflare/codemode/docs/index.md` — the sandbox runtime used by Agents Codemode integrations
- `@cloudflare/ai-chat/README.md` — React chat clients, resumable streams, client tools, approvals, and storage controls

## Choose your path

| You are building...                                     | Use                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| An agent that runs a model loop with tools and recovery | [Pi harness](./harnesses/pi.md) on a Durable Object                                             |
| Your own agent loop                                     | [Sessions](./sessions.md), [Streams](./streams.md), and [Tasks](./tasks.md) on a Durable Object |
| A chat or reasoning agent with every default built in   | [`Think`](https://github.com/cloudflare/agents/blob/main/docs/think/index.md)                   |
| A chat UI that owns the loop and the stream             | [`AIChatAgent`](./chat-agents.md), built on the `Agent` class                                   |
| Real-time state sync, `@callable` methods, email, voice | The [`Agent` class](./agent-class.md), which installs a preset of capabilities for you          |
| Durable multi-step processes (not chat)                 | [Workflows](./workflows.md)                                                                     |

## Getting started

- [Getting Started](./getting-started.md) - Quick start guide for new users
- [Adding to an Existing Project](./adding-to-existing-project.md) - Integrate agents into your app

## Lifecycle

- [Durable Object Lifecycle](./lifecycle.md) - Install a Lifecycle on a Durable Object, write capabilities, and use the job queue
- [getCurrentAgent()](./get-current-agent.md) - Accessing the current object, request, and connection across async calls

## Harnesses

- [Pi harness (Beta)](./harnesses/pi.md) - Host pi-durable sessions in a Durable Object with durable storage and lifecycle wakeups
- [Think harness (Experimental)](./harnesses/think.md) - Run Think's agent loop as a Lifecycle capability, with transcripts in Sessions, output in Streams, and turns that survive eviction
- [Think (Experimental)](https://github.com/cloudflare/agents/blob/main/docs/think/index.md) - Opinionated chat agent with built-in memory, tools, and streaming. Extends `Think`, which builds on `Agent`.

## Capabilities

Install each capability with `lifecycle.use()`. Capabilities marked experimental may change between releases.

| Capability         | Import              | Status       | Docs                                                            |
| ------------------ | ------------------- | ------------ | --------------------------------------------------------------- |
| `PiHarness`        | `agents/harness/pi` | Beta         | [Pi harness](./harnesses/pi.md)                                 |
| `MCPClientManager` | `agents/mcp/client` | Stable       | [MCP client](./mcp-client.md)                                   |
| `Scheduler`        | `agents/schedules`  | Stable       | [Scheduling](./scheduling.md)                                   |
| `State`            | `agents/state`      | Stable       | [Lifecycle](./lifecycle.md#websockets-are-an-opt-in-capability) |
| `WebSockets`       | `agents/websockets` | Stable       | [Lifecycle](./lifecycle.md#websockets-are-an-opt-in-capability) |
| `Queue`            | `agents/queue`      | Experimental | [Queue](./queue.md)                                             |
| `RoutedAgents`     | `agents/routing`    | Experimental | [Routing](./routing.md)                                         |
| `Browser`          | `agents/browser`    | Experimental | [Browse the Web](./browse-the-web.md)                           |
| `Sessions`         | `agents/sessions`   | Experimental | [Sessions](./sessions.md)                                       |
| `Streams`          | `agents/streams`    | Experimental | [Streams](./streams.md)                                         |
| `Tasks`            | `agents/tasks`      | Experimental | [Tasks](./tasks.md)                                             |

Building your own harness? Sessions stores the conversation, Streams holds durable incremental output, and Tasks runs replayable background work. [Models](./models.md) and [Models for pi-ai](./models-pi-ai.md) give you one provider for Workers AI and third-party models. [Context](./context.md) and [Workspace](https://github.com/cloudflare/agents/blob/main/docs/shell/index.md) are also available.

## Agent class

`Agent` extends `DurableObject`, installs a Lifecycle, and adds `Scheduler`, `Queue`, `MCPClientManager`, `State`, `WebSockets`, `Tasks`, and dynamic agents for you. Its methods (`this.schedule()`, `this.queue()`, `this.setState()`) delegate to those capabilities. Features below are documented for `Agent` and its subclasses.

### Core

- [Understanding the Agent Class](./agent-class.md) - How the Agent class is built on the Lifecycle
- [State Management](./state.md) - `setState()`, `initialState`, and `onStateChanged()`
- [Routing](./routing.md) - How `routeAgentRequest()` and agent naming works, plus `RoutedAgents` for a hub that routes to many independent Agents
- [Dynamic agents](./sub-agents.md) - Facet-backed child agents for code the parent supervises (dynamic/generated code, per-run tool agents, sandboxes) — not the recommended primitive for many independent peers like chats
- [HTTP & WebSockets](./http-websockets.md) - Request handling and real-time connections
- [Callable Methods](./callable-methods.md) - The `@callable` decorator and client-server method calls
- [Readonly Connections](./readonly-connections.md) - Restricting which connections can modify state
- [Client SDK](./client-sdk.md) - Connecting from React (`useAgent`) and vanilla JS (`AgentClient`), state sync, and RPC calls

### Background processing

- [Queue](./queue.md) - Durable background task execution
- [Scheduling](./scheduling.md) - Delayed, scheduled, and cron-based tasks
- [Retries](./retries.md) - Automatic retries with exponential backoff and jitter
- [Durable Execution](./durable-execution.md) - `runFiber()`, `startFiber()`, `stash()`, and crash recovery for long tasks
- [Workflows](./workflows.md) - Durable multi-step processing with Cloudflare Workflows
- [Human in the Loop](./human-in-the-loop.md) - Approval flows and manual intervention

### Communication channels

- [Email Service](./email.md) - Sending, receiving, and replying to emails
- [Webhooks](./webhooks.md) - Receiving and sending webhook events
- [Push Notifications](./push-notifications.md) - Browser push notifications via Web Push API and scheduled delivery
- TODO: [SMS](./sms.md) - Text message integration (Twilio, etc.)
- [Voice Agents](./voice.md) - Build voice agents with real-time speech-to-text, text-to-speech, and conversation persistence
- [Chat SDK State](./chat-sdk.md) - Store Chat SDK subscriptions, locks, queues, and history in Agents sub-agents

### Chat and AI

- [Chat Agents](./chat-agents.md) - `AIChatAgent` class and `useAgentChat` React hook
- [Chat & Fiber Recovery](./chat-agents.md#stream-recovery) - Recover LLM turns after Durable Object eviction
- [Agent Tools](./agent-tools.md) - Run chat-capable sub-agents as tools with streaming child timelines
- [Server-Driven Messages](./server-driven-messages.md) - Autonomous agent workflows: scheduled follow-ups, queue processing, webhooks, chained reasoning
- [Client Tools Continuation](./client-tools-continuation.md) - Handling tool calls across client/server
- [Resumable Streaming](./resumable-streaming.md) - Automatic stream resumption on client disconnect
- [Long-Running Agents](./long-running-agents.md) - Building agents that persist for weeks or months: lifecycle, recovery, async operations, and planning
- TODO: [SQL API](./sql.md) - Using `this.sql` for direct database queries
- TODO: [Memory & Persistence](./memory.md) - Long-term storage patterns

## Think (Experimental)

- [Overview](https://github.com/cloudflare/agents/blob/main/docs/think/index.md) - Opinionated chat agent with built-in memory, tools, and streaming
- [Getting Started](https://github.com/cloudflare/agents/blob/main/docs/think/getting-started.md) - Build your first Think agent step by step
- [Lifecycle Hooks](https://github.com/cloudflare/agents/blob/main/docs/think/lifecycle-hooks.md) - `beforeTurn`, `onStepFinish`, `onChunk`, `onChatResponse`, and more
- [Tools](https://github.com/cloudflare/agents/blob/main/docs/think/tools.md) - Workspace tools, code execution, extensions
- [Actions](https://github.com/cloudflare/agents/blob/main/docs/think/actions.md) - Server actions with idempotency, approvals, authorization, and reply attachments
- [Channels](https://github.com/cloudflare/agents/blob/main/docs/think/channels.md) - Per-channel policy, channel selection, and out-of-band notices
- [Messengers](https://github.com/cloudflare/agents/blob/main/docs/think/messengers.md) - Receive and reply to Chat SDK messenger webhooks from Think
- [Client Tools](https://github.com/cloudflare/agents/blob/main/docs/think/client-tools.md) - Browser-side tools, approvals, and concurrency
- [Sub-agents and Programmatic Turns](https://github.com/cloudflare/agents/blob/main/docs/think/sub-agents.md) - RPC streaming, `saveMessages`, recovery
- [Programmatic Submissions](https://github.com/cloudflare/agents/blob/main/docs/think/programmatic-submissions.md) - Durable Think turn admission for webhooks and RPC callers

## Models and tools

- TODO: [AI SDK Integration](./ai-sdk.md) - Using Vercel AI SDK with agents
- TODO: [TanStack Integration](./tanstack.md) - Using TanStack AI with agents
- TODO: [Using AI Models](./using-ai-models.md) - OpenAI, Anthropic, Workers AI, and other providers
- [Models (Experimental)](./models.md) - `createAI` — one AI SDK provider for Workers AI and third-party catalog models, same string space
- [Models for pi-ai (Beta)](./models-pi-ai.md) - `createAI` for pi-ai: Workers AI ids and third-party models through AI Gateway, as a pi-ai provider
- [Context (Experimental)](./context.md) - System-prompt blocks, frozen prompts, writable/searchable/loadable providers, and their tools
- [Workspace (Experimental)](https://github.com/cloudflare/agents/blob/main/docs/shell/index.md) - Durable virtual filesystem backed by SQLite + R2
- [Codemode (Experimental)](./codemode.md) - LLM-generated executable code for tool orchestration
- [Browse the Web (Experimental)](./browse-the-web.md) - Full CDP access for web inspection, scraping, and debugging
- [Search the Web (Beta)](./search-the-web.md) - A `websearch` tool over Cloudflare's Web Search API for the pi harness, the AI SDK, and TanStack AI
- [Fetch the Web (Beta)](./fetch-the-web.md) - A `web_fetch` tool that reads a URL as Markdown, JSON, or text, with a host-controlled URL policy, for the pi harness, the AI SDK, TanStack AI, and Think
- TODO: [Cloudflare Sandboxes](./sandboxes.md) - Isolated environments for coding agents, ffmpeg, and heavy compute
- TODO: [RAG (Retrieval Augmented Generation)](./rag.md) - Vector search with Vectorize

## MCP (Model Context Protocol)

- [Creating MCP Servers](./mcp-servers.md) - Build MCP servers with `McpAgent`
- [Securing MCP Servers](./securing-mcp-servers.md) - OAuth and authentication for MCP
- [Connecting to MCP Servers](./mcp-client.md) - `MCPClientManager` on a Durable Object, or `addMcpServer()` on an Agent
- [MCP Transports](./mcp-transports.md) - Transport options: Streamable HTTP, SSE, and RPC

## Operations

- [Configuration](./configuration.md) - wrangler.jsonc setup, types, secrets, and deployment
- [Observability](./observability.md) - Monitoring and tracing agent activity
- [Cross-Domain Authentication](./cross-domain-authentication.md) - Auth across different domains
- TODO: [Securing your Agents](./securing-agents.md) - Authentication, authorization, and access control
- TODO: [Testing](./testing.md) - Unit tests, integration tests, mocking agents
- TODO: [Evals](./evals.md) - Evaluating AI agent quality and behavior
- TODO: [Agent Studio](./agent-studio.md) - Local dev tool for inspecting and interacting with agent instances

## Migration guides

- [Migration to AI SDK v5](./migration-to-ai-sdk-v5.md)
- [Migration to AI SDK v6](./migration-to-ai-sdk-v6.md)

## Reference

- TODO: [API Reference](./api-reference.md) - Complete API documentation
- TODO: [FAQ / How is this different from Durable Objects?](./faq.md)
- TODO: [Resources & Further Reading](./resources.md)

---

## Contributing

Found something missing? Documentation contributions are welcome!
