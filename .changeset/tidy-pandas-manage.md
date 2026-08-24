---
"agents": minor
---

Make `MCPClientManager` a reusable Agent lifecycle capability. It now owns schema initialization, persisted HTTP and RPC connection restoration, and OAuth callback interception when installed with `Lifecycle.use()`, while preserving `Agent.this.mcp` and the existing Agent MCP APIs. Lifecycle now owns the current Agent context for capability and user hooks. `agents/lifecycle` exports the base `Agent` interface and canonical `getCurrentAgent()` accessor; `agents` keeps the same accessor as a compatibility alias.
