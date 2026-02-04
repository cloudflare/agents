# Agents Documentation

## Getting Started

- [Getting Started](./getting-started.md) - Quick start guide for new users
- [Adding to an Existing Project](./adding-to-existing-project.md) - Integrate agents into your app
- [Understanding the Agent Class](./agent-class.md) - Deep dive into the Agent class architecture

## Core Concepts

- [State Management](./state.md) - Managing agent state with `setState()`, `initialState`, and `onStateUpdate()`
- [Routing](./routing.md) - How `routeAgentRequest()` and agent naming works
- [HTTP & WebSockets](./http-websockets.md) - Request handling and real-time connections
- [Callable Methods](./callable-methods.md) - The `@callable` decorator and client-server method calls
- [getCurrentAgent()](./get-current-agent.md) - Accessing agent context across async calls

## Client SDK

- [Client SDK](./client-sdk.md) - Connecting from React (`useAgent`) and vanilla JS (`AgentClient`), state sync, and RPC calls

## Communication Channels

- [Email Routing](./email.md) - Receiving and responding to emails
- [Webhooks](./webhooks.md) - Receiving and sending webhook events
- TODO: [SMS](./sms.md) - Text message integration (Twilio, etc.)
- TODO: [Voice & Audio](./voice-audio.md) - Voice calls, audio streaming, and speech-to-text
- TODO: [Messengers](./messengers.md) - Slack, Discord, Telegram, and other chat platforms

## Background Processing

- [Queue](./queue.md) - Immediate background task execution
- [Scheduling](./scheduling.md) - Delayed, scheduled, and cron-based tasks
- [Workflows](./workflows.md) - Durable multi-step processing with Cloudflare Workflows
- [Human in the Loop](./human-in-the-loop.md) - Approval flows and manual intervention

## AI Integration

- TODO: [AI SDK Integration](./ai-sdk.md) - Using Vercel AI SDK with agents
- TODO: [TanStack Integration](./tanstack.md) - Using TanStack AI with agents
- TODO: [Chat Agents](./chat-agents.md) - `AIChatAgent` class and `useAgentChat` React hook
- TODO: [Using AI Models](./using-ai-models.md) - OpenAI, Anthropic, Workers AI, and other providers
- TODO: [RAG (Retrieval Augmented Generation)](./rag.md) - Vector search with Vectorize
- [Codemode (Experimental)](./codemode.md) - LLM-generated executable code for tool orchestration
- [Client Tools Continuation](./client-tools-continuation.md) - Handling tool calls across client/server

## MCP (Model Context Protocol)

- [Creating MCP Servers](./mcp-servers.md) - Build MCP servers with `McpAgent`
- [Securing MCP Servers](./securing-mcp-servers.md) - OAuth and authentication for MCP
- [Connecting to MCP Servers](./mcp-client.md) - `addMcpServer()` and consuming external MCP tools

## Authentication & Security

- TODO: [Securing your Agents](./securing-agents.md) - Authentication, authorization, and access control
- [Cross-Domain Authentication](./cross-domain-authentication.md) - Auth across different domains
- [Resumable Streaming](./resumable-streaming.md) - Handling interrupted streams

## Observability & Debugging

- [Observability](./observability.md) - Monitoring and tracing agent activity
- TODO: [Testing](./testing.md) - Unit tests, integration tests, mocking agents
- TODO: [Evals](./evals.md) - Evaluating AI agent quality and behavior

## Agent Studio

- TODO: [Agent Studio](./agent-studio.md) - Local dev tool for inspecting and interacting with agent instances

## Compute Environments

- TODO: [Browse the Web](./browse-the-web.md) - Headless browser for web scraping and automation
- TODO: [Cloudflare Sandboxes](./sandboxes.md) - Isolated environments for coding agents, ffmpeg, and heavy compute

## Advanced Topics

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
