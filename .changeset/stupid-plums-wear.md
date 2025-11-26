---
"agents": patch
---

fix: add session ID and header support to SSE transport

The SSE transport now properly forwards session IDs and request headers to MCP message handlers, achieving closer header parity with StreamableHTTP transport. This allows MCP servers using SSE to access request headers for session management.
