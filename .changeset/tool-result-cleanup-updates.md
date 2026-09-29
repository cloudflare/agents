---
"agents": patch
---

Fix `useAgentChat` throwing "Maximum update depth exceeded" partway through long streamed answers (#2217). The effect that prunes stale client tool results dispatched a state update on every message change, even when there was nothing to prune. During a stream each of those updates counted toward React's nested update limit, so an answer with enough chunks crashed, with or without a throttle. The effect now only dispatches when an entry is actually stale.
