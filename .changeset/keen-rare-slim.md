---
"agents": patch
---

Fix: MCP OAuth callback errors are now returned as structured results instead of throwing unhandled exceptions. Errors with an active connection properly transition to "failed" state and are surfaced to clients via WebSocket broadcast.
