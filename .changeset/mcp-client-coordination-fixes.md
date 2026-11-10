---
"agents": patch
---

MCP client: fix races between OAuth callbacks, token refreshes, step-ups and server changes.

- A pending step-up link still completes after the session refreshes its token. Before, the refresh deleted the OAuth discovery state the callback needs, and the server was marked failed.
