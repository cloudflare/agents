---
"agents": minor
---

Make `MCPClientManager` a self-contained Agent lifecycle component. Construct it with `new MCPClientManager(this, { name, version })`; the previous standalone storage-only constructor is removed. Existing `Agent.mcp`, `addMcpServer()`, and MCP protocol behavior are preserved.
