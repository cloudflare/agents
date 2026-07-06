---
"agents": patch
---

Fix `addMcpServer()` reporting `ready` for an HTTP MCP connection that was restored while OAuth is still in progress.

For an existing `AUTHENTICATING` connection, `addMcpServer()` now prefers the live authorization URL, otherwise returns a persisted absolute HTTP(S) authorization URL. If neither is available, it reconnects the existing connection without re-registering it: a new authorization URL is returned and persisted, a connected result is discovered before returning `ready`, and failed or incomplete OAuth results throw instead of falling through to `ready`.
