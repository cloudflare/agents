---
"agents": patch
---

Fix AgentClient.close() to immediately reject pending RPC calls instead of waiting for WebSocket close handshake timeout.

Previously, calling `client.close()` would not reject pending RPC calls until the WebSocket close handshake completed (which could take 15+ seconds in some environments). Now pending calls are rejected immediately when `close()` is called, providing faster feedback on intentional disconnects.
