---
"agents": patch
---

Verify MCP OAuth callback state before changing a connection. Forged, expired, and replayed callbacks no longer disrupt the genuine authorization flow, and `addMcpServer()` refreshes auth URLs whose embedded state has expired.
