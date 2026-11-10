---
"agents": patch
---

MCP client: fix races between OAuth callbacks, token refreshes, step-ups and server changes.

- A pending step-up link still completes after the session refreshes its token. Before, the refresh deleted the OAuth discovery state the callback needs, and the server was marked failed.
- A step-up callback no longer loses its grant to a token refresh that was running at the same time.
- A removed server's tokens are no longer saved again by a refresh that was still in flight.
- A callback that finishes after `closeConnection()` keeps the sign-in, and no longer reports the server as removed.
- A link issued before `closeConnection()` can no longer mark the server failed after it is added again.
- `addMcpServer(..., { id })` for a server waiting on a sign-in link hands back a link that works. Before, the link named the old id and its callback was never handled.
- `configureElicitationHandlers()` while a server connects (for example from `onStart` after a wake) no longer fails that server.
- With a custom OAuth provider, a step-up that races a reconnect no longer leaves a saved link on a ready server.
