---
"agents": patch
---

Fix OAuth authentication for MCP servers and add transport configuration

- Fix authorization codes being consumed during transport fallback
- Add transport type option to addMcpServer() for explicit control
- Add configurable OAuth callback handling (redirects, custom responses)
- Fix callback URL persistence across Durable Object hibernation
