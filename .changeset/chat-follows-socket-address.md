---
"agents": patch
---

`useAgentChat` now loads the new agent's history when the `name` passed to `useAgent` changes (#1864, #1874). The socket for the new name is created a render later, and until then `useAgentChat` fetched `get-messages` through the previous socket's URL. That URL carried the previous agent's path and auth token, and the result was cached under the new agent, so the new agent's history never loaded. While the socket is behind, `useAgent().getHttpUrl()` now returns `""`, and `useAgentChat` keeps showing the previous conversation, then loads the new one once through the new socket. `agent.name` switches to the new name right away, and a name change no longer calls `onIdentityChange` or logs "Identity changed on reconnect". This also applies to host, sub-agent and path changes. Token-only changes still don't reload history.
