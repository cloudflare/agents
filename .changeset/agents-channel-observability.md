---
"agents": patch
---

Add `channel:resolved`, `channel:delivered`, `notice:delivered`, and `notice:failed` observability events to `AgentObservabilityEvent` for the Think channels surface. These route to a dedicated `agents:channel` diagnostics channel and are reachable via the typed `subscribe("channel", cb)` API (new `ChannelEventMap` bucket) rather than falling through to the catch-all `lifecycle` channel.
