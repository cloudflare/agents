---
"agents": patch
"@cloudflare/ai-chat": patch
---

Add `agent` and `name` fields to observability events, identifying which agent class and instance emitted each event.

New events: `disconnect` (WebSocket close), `email:receive`, `email:reply`, `queue:create`, and a new `agents:email` channel.

Make `_emit` protected so subclasses can use it. Update `AIChatAgent` to use `_emit` so message/tool events carry agent identity.
