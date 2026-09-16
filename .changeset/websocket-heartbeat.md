---
"agents": patch
---

WebSocket heartbeat, so an idle Agent socket is no longer dropped silently (#2242).

Cloudflare closes a WebSocket that carries no traffic for a while without a close frame, so the browser still reported the socket as open, the next `useAgentChat` message went nowhere, and no reconnect ran.

- Server: the `WebSockets` capability registers a `ping` → `pong` auto-response pair before its first hibernating accept, on `Agent` and plain hosts alike, so the platform answers pings without waking the object. A `ping` that reaches the capability anyway (the Cap'n Web wire) is answered directly and never reaches `onMessage`. A host that wants the frame for itself opts out with `heartbeat: false` on the capability.
- Client: `AgentClient` and `useAgent` send `ping` every 30 s while open and reconnect if no `pong` arrives within 10 s. Tune with `heartbeat: { intervalMs, timeoutMs }` or disable with `heartbeat: false`. `pong` frames never reach `onMessage` or `useAgentChat`.

Old clients that never ping are unaffected; an old server that does not answer is reconnected after each timeout.
