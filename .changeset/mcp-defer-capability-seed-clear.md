---
"agents": patch
---

MCP client: consume the persisted capability seed at first use instead of at restore-time read

The capability stamp persisted on each MCP server row (used to re-advertise elicitation modes at the handshake after Durable Object hibernation) was read-and-cleared when the connection object was created, before any connection attempt. Wakes that never reached a handshake burned it: a restore that parked on a pending OAuth flow, or a wake interrupted between restore and `onStart` re-stamping the rows, left the next wake's connections negotiating without the elicitation capability until some later reconnect.

The stamp is now read without clearing and only cleared once a seeded handshake actually completes in a session that has not configured handlers, preserving the one-successful-restore semantics: after the seed is used in a completed handshake it no longer re-advertises stale modes, and any `configureElicitationHandlers` call still re-stamps every row. Sessions with handlers configured own their row stamps, so a handshake there (e.g. re-adding a server under a stable id) keeps the fresh stamp in place for the next wake.
