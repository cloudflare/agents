---
"agents": minor
---

Make `MCPClientManager` a reusable Durable Object lifecycle capability. It now owns schema initialization, persisted HTTP and RPC connection restoration, and OAuth callback interception when installed with `Lifecycle.use()`. Add a host execution boundary for capability phases so `Agent` can install `this.mcp` directly while preserving Agent invocation context, facet hydration, tracing, and existing MCP APIs.
