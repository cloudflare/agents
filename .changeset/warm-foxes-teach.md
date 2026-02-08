---
"agents": minor
---

Deprecate `onStateUpdate` server-side hook in favor of `onStateChanged`

- `onStateChanged` is a drop-in rename of `onStateUpdate` (same signature, same behavior)
- `onStateUpdate` still works but emits a one-time console warning per class
- Throws if a class overrides both hooks simultaneously
- `validateStateChange` rejections now propagate a `CF_AGENT_STATE_ERROR` message back to the client
