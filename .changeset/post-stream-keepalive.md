---
"agents": patch
---

Add keepalive ping to POST SSE response streams in WorkerTransport

The GET SSE handler already sends `event: ping` every 30 seconds to keep the connection alive, but the POST SSE handler did not. This caused POST response streams to be silently dropped by proxies and infrastructure during long-running tool calls (e.g., MCP tools/call), resulting in clients never receiving the response.
