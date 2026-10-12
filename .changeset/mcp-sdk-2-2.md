---
"agents": patch
---

Update the MCP dependencies to `@modelcontextprotocol/client@2.2.0` and `@modelcontextprotocol/server@2.2.0`, and the SDK v1 compatibility dependency to `@modelcontextprotocol/sdk@1.31.0`. The client and server move together so both resolve the same `@modelcontextprotocol/core`. Stored OAuth credentials now carry the SDK's `issuer` stamp, and `listTools()` and the other list calls fetch every page.
