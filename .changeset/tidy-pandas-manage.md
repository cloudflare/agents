---
"agents": minor
---

Make `MCPClientManager` a reusable Durable Object lifecycle capability. It now owns schema initialization, persisted HTTP and RPC connection restoration, and OAuth callback interception when installed with `Lifecycle.use()`, while preserving `Agent.this.mcp` and the existing Agent MCP APIs.
