---
"agents": patch
---

Make `callbackHost` optional in `addMcpServer` for non-OAuth servers

Previously, `addMcpServer()` always required a `callbackHost` (either explicitly or derived from the request context) and eagerly created an OAuth auth provider, even when connecting to MCP servers that do not use OAuth. This made simple non-OAuth connections unnecessarily difficult, especially from WebSocket callable methods where the request context origin is unreliable.

Now, `callbackHost` and the OAuth auth provider are only required when the MCP server actually needs OAuth (returns a 401/AUTHENTICATING state). For non-OAuth servers, `addMcpServer("name", url)` works with no additional options. If an OAuth server is encountered without a `callbackHost`, a clear error is thrown: "This MCP server requires OAuth authentication. Provide callbackHost in addMcpServer options to enable the OAuth flow."

The restore-from-storage flow also handles missing callback URLs gracefully, skipping auth provider creation for non-OAuth servers.
