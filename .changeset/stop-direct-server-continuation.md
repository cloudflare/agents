---
"agents": patch
---

`useAgentChat().stop()` now cancels a server-started turn that streams to an open connection without a resume handshake, such as a `continueLastTurn()` continuation.
