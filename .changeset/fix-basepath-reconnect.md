---
"agents": patch
---

Fix `useAgent` and `AgentClient` crashing when using `basePath` routing. `PartySocket.reconnect()` requires `room` to be set, but `basePath` mode bypasses room-based URL construction. The fix provides `room` and `party` in socket options even when `basePath` is used, as a workaround pending a fix in partysocket.
