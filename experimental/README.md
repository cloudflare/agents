# Experimental

This folder contains experiments and future-facing work. Everything here uses unstable or experimental Cloudflare APIs (Durable Object Facets, Worker Loaders, `ctx.exports`) and should **not be used in production**.

The code here is for exploration, prototyping, and validating patterns that may eventually be pulled into the Agents SDK as stable features.

## Contents

- **[gadgets.md](./gadgets.md)** — Exploration of facets, isolation, and structural safety for agents. Covers the Gatekeeper/ApprovalQueue pattern, Worker Loader sandboxing, sub-agent facets, multi-room chat, and other patterns worth pulling into the SDK.
- **[webmcp.md](./webmcp.md)** — Design notes for `agents/experimental/webmcp`, the adapter that bridges `McpAgent` tools into Chrome's native `navigator.modelContext` API. Covers the in-page-plus-remote composition pattern, the API surface, error model, concurrency semantics, and edge cases.
- **[forever.md](./forever.md)** — Design doc for durable long-running execution. Covers `keepAlive`, `runFiber` (checkpointing, eviction recovery), and `AIChatAgent` chat recovery via `onChatRecovery`. Built into the `Agent` and `AIChatAgent` base classes.
- **[forever-fibers/](./forever-fibers/)** — Example of `Agent.runFiber()` for durable background work with real-time progress tracking.
- **[forever-chat/](./forever-chat/)** — Example of `AIChatAgent` with `chatRecovery` for multi-provider chat recovery (Workers AI, OpenAI, Anthropic).
- **[session-memory](./session-memory/)** — Example of the Session API for conversation history with automatic compaction. Demonstrates `agents/experimental/memory/session` with micro-compaction and LLM-based summarization.
