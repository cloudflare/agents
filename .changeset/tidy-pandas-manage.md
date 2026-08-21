---
"agents": minor
---

Make `MCPClientManager` a reusable Durable Object lifecycle capability. It now owns schema initialization, persisted HTTP and RPC connection restoration, and OAuth callback interception when installed with `Lifecycle.use()`, while preserving the default `Agent.this.mcp` and existing Agent MCP APIs.
