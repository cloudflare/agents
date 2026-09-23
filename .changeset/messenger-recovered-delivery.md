---
"@cloudflare/think": patch
---

Deliver the recovered answer to the messenger thread when chat recovery continues an interrupted messenger turn. Previously the thread got the "reply was interrupted, please send again" apology and the recovered answer only reached WebSocket clients, so a user who re-sent started a duplicate turn. The apology is now posted only when recovery gives up. This works for both root-agent and per-thread sub-agent conversation targets. `StreamCallback.onInterrupted` receives an optional `{ deliversRecoveredReply }` argument.

Also stop offering `bindActiveDeliverySurface` across the sub-agent RPC boundary, where the live thread could not be serialized and the call rejected unhandled.
