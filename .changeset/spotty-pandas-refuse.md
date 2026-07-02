---
"agents": patch
---

fix: `addMcpServer` no longer reports `ready` for a restored connection that is still awaiting OAuth.

A connection restored after a Durable Object wake (hibernation, eviction, redeploy) keeps its persisted `AUTHENTICATING` state, but the OAuth provider's in-memory `authUrl` was never rehydrated. The existing-connection early return in `addMcpServer` required that in-memory URL to report `authenticating`, so it fell through to `ready` — while `getMcpServers()` correctly reported `authenticating` for the same server. Callers driving OAuth off the return value stopped re-surfacing the sign-in link and the flow wedged silently.

`addMcpServer` now falls back to the persisted `auth_url` for authenticating connections, so its return value matches `getMcpServers()`. If no auth URL exists in memory or storage, it re-runs the connect flow to mint a fresh one instead of reporting `ready`. Re-adding a known server also reuses its existing id on the HTTP path (as the RPC path already did) instead of generating a new one.
