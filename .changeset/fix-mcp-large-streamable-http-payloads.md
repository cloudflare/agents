---
"agents": patch
---

Fix MCP streamable HTTP transport failures for large JSON-RPC request bodies by sending Worker-to-Durable Object payloads over the internal WebSocket data channel instead of encoding them into headers.
