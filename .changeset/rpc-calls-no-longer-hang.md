---
"agents": minor
---

Fix RPC calls hanging forever during connection churn (#1738).

`useAgent`'s RPC layer now survives socket replacement. `usePartySocket` creates a brand-new socket whenever connection options change (async query refresh, `enabled` toggle, path change) — previously, a call issued against a stale `agent` reference was buffered inside the permanently-closed old socket and its promise never settled, and a call transmitted just before replacement lost its response with no rejection either.

- `agent.call()` (and `agent.stub` / `agent.setState`) now route through the live socket, so stale references captured by mount-time effects keep working.
- RPC requests are only handed to a socket once it's open. Until then they're queued by the hook and flushed on the next open — including on a replacement socket. This is safe: queued requests were never transmitted, so they can't double-execute.
- Calls whose request was already transmitted are rejected with `Connection closed` when their socket closes or is replaced (the response is connection-bound and can never arrive). Calls in flight on a newer socket are no longer spuriously rejected by a stale close event from an old socket.
- Queued calls only follow the connection to the _same_ agent instance. If the hook is re-pointed at a different address (the `agent`, `name`, `basePath`, or path props change) before a queued call could be transmitted, the call is rejected instead of executing against an instance it wasn't composed for.
- `AgentClient` similarly keeps buffered (untransmitted) calls pending across transient disconnects — PartySocket re-sends them on reconnect — and only rejects calls the server actually received.
- Non-streaming calls now have a default 30s timeout as a backstop so lost responses reject instead of hanging. Configure per client via `defaultCallTimeout` (0 disables) on `useAgent` / `AgentClient`, or per call via the existing `timeout` option (`timeout: 0` opts out). Streaming calls are exempt.
- RPC responses that arrive with no matching pending call (e.g. after a timeout) now log a `console.warn` instead of being silently discarded.
