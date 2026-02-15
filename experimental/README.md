# Experimental

This folder contains experiments and future-facing work. Everything here uses unstable or experimental Cloudflare APIs (Durable Object Facets, Worker Loaders, `ctx.exports`) and should **not be used in production**.

The code here is for exploration, prototyping, and validating patterns that may eventually be pulled into the Agents SDK as stable features.

## Contents

- **[gadgets.md](./gadgets.md)** — Exploration of facets, isolation, and structural safety for agents. Covers the Gatekeeper/ApprovalQueue pattern, Worker Loader sandboxing, sub-agent facets, multi-room chat, and other patterns worth pulling into the SDK.
- **[forever.md](./forever.md)** — Design doc for durable long-running execution. Covers keepAlive, fibers (spawnFiber/stashFiber), eviction recovery, and AIChatAgent integration. Implemented as mixins in `agents/experimental/forever` and `@cloudflare/ai-chat/experimental/forever`.
