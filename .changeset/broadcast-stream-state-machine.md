---
"agents": minor
---

Add `broadcastTransition` to `agents/chat` — a pure state machine for
managing StreamAccumulator lifecycle during broadcast/resume streams.
Replaces scattered ref management in useAgentChat with explicit state
transitions.
