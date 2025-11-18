---
"agents": patch
---

fix: add session ID, auth, and header support to SSE transport

The SSE transport now properly forwards session IDs, authentication info, and request headers to MCP message handlers, achieving feature parity with StreamableHTTP transport. This allows MCP servers using SSE to access critical request context for authentication and session management.
