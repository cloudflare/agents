# Agents Documentation

Build stateful AI agents on Cloudflare Workers. Every agent is a Durable Object — an addressable, hibernatable actor with its own SQLite database, WebSockets, and scheduling — so you can afford one durable agent per user, account, task, or conversation, with near-zero cost while idle.

## Choose your path

Pick the base class that matches what you are building. They share the same Durable Object foundation, so you can start small and move up without re-platforming.

| You are building...                                            | Use                               | Why                                                                                                                    |
| -------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Stateful backend logic, real-time sync, custom protocols       | [`Agent`](./agent-class.md)       | The core class: state, WebSockets, scheduling, SQL, and sub-agents. No opinions about chat or LLMs.                    |
| A chat UI where you own the loop, the stream, and the response | [`AIChatAgent`](./chat-agents.md) | A thin chat-protocol adapter for `useAgentChat`. Bring your own agentic loop and custom streaming.                     |
| A durable, general-purpose reasoning agent                     | [`Think`](./think/index.md)       | Opinionated runtime: agentic loop, sessions, tools, memory, compaction, recovery, and multi-channel delivery built in. |
| A voice agent (speech in, speech out)                          | [Voice mixins](./voice.md)        | `withVoice` adds real-time STT/TTS, interruption and barge-in, and conversation persistence to an agent.               |
| Durable multi-step processes (not chat)                        | [Workflows](./workflows.md)       | Long-running, retryable step orchestration with Cloudflare Workflows.                                                  |

Not sure? Start with [`Agent`](./agent-class.md) for raw building blocks, or [`Think`](./think/index.md) if you want a chat or reasoning agent that already handles the hard parts.

## What makes these production-grade

The differentiator is not "we have durable state" — it is what happens when a turn is interrupted. Agents built on this SDK keep their promises across Durable Object eviction, deploys, client disconnects, and human waits:

- **Turn recovery** — an in-flight LLM turn survives Durable Object eviction and resumes instead of silently dying. See [Chat & Fiber Recovery](./chat-agents.md#stream-recovery) and [Durable Execution](./durable-execution.md).
- **Resumable streams** — a disconnected client rejoins the same stream rather than losing the response. See [Resumable Streaming](./resumable-streaming.md).
- **Recovery-aware delivery** — Think snapshots channel delivery as `accepted`, `streaming`, or `completed`, so a restart replays a not-yet-streamed answer but posts a safe interruption notice rather than risking a duplicate partial reply. See [Messengers — Delivery and Recovery](./think/messengers.md#delivery-and-recovery).
- **Durable submissions** — webhooks and RPC callers submit a turn with an idempotency key and check status later, instead of holding a request open. See [Programmatic Submissions](./think/programmatic-submissions.md).
- **Human-in-the-loop without hangs** — a turn can pause for approval and resume later. A human wait is a first-class state, not a stuck request. See [Human in the Loop](./human-in-the-loop.md).

## Getting Started

- [Getting Started](./getting-started.md) - Quick start guide for new users
- [Adding to an Existing Project](./adding-to-existing-project.md) - Integrate agents into your app
- [Understanding the Agent Class](./agent-class.md) - Deep dive into the Agent class architecture

## Core Concepts

- [State Management](./state.md) - Managing agent state with `setState()`, `initialState`, and `onStateChanged()`
- [Routing](./routing.md) - How `routeAgentRequest()` and agent naming works
- [Sub-agents](./sub-agents.md) - Parent/child DO composition via facets, nested routing, and direct child connections
- [HTTP & WebSockets](./http-websockets.md) - Request handling and real-time connections
- [Callable Methods](./callable-methods.md) - The `@callable` decorator and client-server method calls
- [Readonly Connections](./readonly-connections.md) - Restricting which connections can modify state
- [getCurrentAgent()](./get-current-agent.md) - Accessing agent context across async calls

## Client SDK

- [Client SDK](./client-sdk.md) - Connecting from React (`useAgent`) and vanilla JS (`AgentClient`), state sync, and RPC calls

## Communication Channels

- [Email Service](./email.md) - Sending, receiving, and replying to emails
- [Webhooks](./webhooks.md) - Receiving and sending webhook events
- [Push Notifications](./push-notifications.md) - Browser push notifications via Web Push API and scheduled delivery
- TODO: [SMS](./sms.md) - Text message integration (Twilio, etc.)
- [Voice Agents](./voice.md) - Build voice agents with real-time speech-to-text, text-to-speech, and conversation persistence
- [Chat SDK State](./chat-sdk.md) - Store Chat SDK subscriptions, locks, queues, and history in Agents sub-agents
- TODO: [Messengers](./messengers.md) - Slack, Discord, Telegram, and other chat platforms

## Background Processing

- [Queue](./queue.md) - Immediate background task execution
- [Scheduling](./scheduling.md) - Delayed, scheduled, and cron-based tasks
- [Retries](./retries.md) - Automatic retries with exponential backoff and jitter
- [Durable Execution](./durable-execution.md) - `runFiber()`, `startFiber()`, `stash()`, and crash recovery for long tasks
- [Workflows](./workflows.md) - Durable multi-step processing with Cloudflare Workflows
- [Human in the Loop](./human-in-the-loop.md) - Approval flows and manual intervention

## AI Integration

- TODO: [AI SDK Integration](./ai-sdk.md) - Using Vercel AI SDK with agents
- TODO: [TanStack Integration](./tanstack.md) - Using TanStack AI with agents
- [Chat Agents](./chat-agents.md) - `AIChatAgent` class and `useAgentChat` React hook
- [Chat & Fiber Recovery](./chat-agents.md#stream-recovery) - Recover LLM turns after Durable Object eviction
- [Agent Tools](./agent-tools.md) - Run chat-capable sub-agents as tools with streaming child timelines
- [Server-Driven Messages](./server-driven-messages.md) - Autonomous agent workflows: scheduled follow-ups, queue processing, webhooks, chained reasoning
- TODO: [Using AI Models](./using-ai-models.md) - OpenAI, Anthropic, Workers AI, and other providers
- TODO: [RAG (Retrieval Augmented Generation)](./rag.md) - Vector search with Vectorize
- [Sessions (Experimental)](./sessions.md) - Persistent conversation storage with tree-structured messages, context blocks, compaction, and search
- [Workspace (Experimental)](./workspace.md) - Durable virtual filesystem backed by SQLite + R2
- [Codemode (Experimental)](./codemode.md) - LLM-generated executable code for tool orchestration
- [Client Tools Continuation](./client-tools-continuation.md) - Handling tool calls across client/server
- [Resumable Streaming](./resumable-streaming.md) - Automatic stream resumption on client disconnect

## Think (Experimental)

- [Overview](./think/index.md) - Opinionated chat agent with built-in memory, tools, and streaming
- [Getting Started](./think/getting-started.md) - Build your first Think agent step by step
- [Lifecycle Hooks](./think/lifecycle-hooks.md) - `beforeTurn`, `onStepFinish`, `onChunk`, `onChatResponse`, and more
- [Tools](./think/tools.md) - Workspace tools, code execution, extensions
- [Actions](./think/actions.md) - Server actions with idempotency, approvals, authorization, and reply attachments
- [Channels](./think/channels.md) - Per-channel policy, channel selection, and out-of-band notices
- [Messengers](./think/messengers.md) - Receive and reply to Chat SDK messenger webhooks from Think
- [Client Tools](./think/client-tools.md) - Browser-side tools, approvals, and concurrency
- [Sub-agents and Programmatic Turns](./think/sub-agents.md) - RPC streaming, `saveMessages`, recovery
- [Programmatic Submissions](./think/programmatic-submissions.md) - Durable Think turn admission for webhooks and RPC callers

## MCP (Model Context Protocol)

- [Creating MCP Servers](./mcp-servers.md) - Build MCP servers with `McpAgent`
- [Securing MCP Servers](./securing-mcp-servers.md) - OAuth and authentication for MCP
- [Connecting to MCP Servers](./mcp-client.md) - `addMcpServer()` and consuming external MCP tools
- [MCP Transports](./mcp-transports.md) - Transport options: Streamable HTTP, SSE, and RPC

## Authentication & Security

- TODO: [Securing your Agents](./securing-agents.md) - Authentication, authorization, and access control
- [Cross-Domain Authentication](./cross-domain-authentication.md) - Auth across different domains

## Observability & Debugging

- [Observability](./observability.md) - Monitoring and tracing agent activity
- TODO: [Testing](./testing.md) - Unit tests, integration tests, mocking agents
- TODO: [Evals](./evals.md) - Evaluating AI agent quality and behavior

## Agent Studio

- TODO: [Agent Studio](./agent-studio.md) - Local dev tool for inspecting and interacting with agent instances

## Compute Environments

- [Browse the Web (Experimental)](./browse-the-web.md) - Full CDP access for web inspection, scraping, and debugging
- TODO: [Cloudflare Sandboxes](./sandboxes.md) - Isolated environments for coding agents, ffmpeg, and heavy compute

## Advanced Topics

- [Long-Running Agents](./long-running-agents.md) - Building agents that persist for weeks or months: lifecycle, recovery, async operations, and planning
- TODO: [SQL API](./sql.md) - Using `this.sql` for direct database queries
- TODO: [Memory & Persistence](./memory.md) - Long-term storage patterns
- [Configuration](./configuration.md) - wrangler.jsonc setup, types, secrets, and deployment

## Migration Guides

- [Migration to AI SDK v5](./migration-to-ai-sdk-v5.md)
- [Migration to AI SDK v6](./migration-to-ai-sdk-v6.md)

## Reference

- TODO: [API Reference](./api-reference.md) - Complete API documentation
- TODO: [FAQ / How is this different from Durable Objects?](./faq.md)
- TODO: [Resources & Further Reading](./resources.md)

---

## Contributing

Found something missing? Documentation contributions are welcome!
