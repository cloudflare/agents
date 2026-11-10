---
"agents": patch
---

MCP client: fix races between OAuth callbacks, token refreshes, step-ups and server changes.

- A pending step-up link still completes after the session refreshes its token. Before, the refresh deleted the OAuth discovery state the callback needs, and the server was marked failed.
- A step-up callback no longer loses its grant to a token refresh that was running at the same time.
- A removed server's tokens are no longer saved again by a refresh that was still in flight.
