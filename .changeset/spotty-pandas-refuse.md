---
"agents": patch
---

fix: `addMcpServer` no longer reports `ready` for a restored connection that is still awaiting OAuth.

A connection restored after a Durable Object wake (hibernation, eviction, redeploy) keeps its persisted `AUTHENTICATING` state, but the OAuth provider's in-memory `authUrl` was never rehydrated. The existing-connection early return in `addMcpServer` required that in-memory URL to report `authenticating`, so it fell through to `ready` — while `getMcpServers()` correctly reported `authenticating` for the same server. Callers driving OAuth off the return value stopped re-surfacing the sign-in link and the flow wedged silently.

`addMcpServer` now falls back to the persisted `auth_url` for authenticating connections, so its return value matches `getMcpServers()`. The persisted URL is only served while its OAuth state is still redeemable (validated via the provider's `checkState`); if the state has expired — or no auth URL exists in memory or storage — `addMcpServer` re-runs the connect flow to mint a fresh sign-in link instead of serving a dead one or reporting `ready`. Re-adding a known server also reuses its existing id on the HTTP path (as the RPC path already did) instead of generating a new one and orphaning the stored row.
