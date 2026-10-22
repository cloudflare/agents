---
"agents": patch
---

`MCPClientManager.callTool()`, `readResource()` and `getPrompt()` surface mid-session re-authorization. When a request on a ready connection fails with `403 insufficient_scope` (scope step-up) or a `401` whose refresh fails, the manager moves the server to `authenticating`, saves the new `auth_url`, and throws `MCPAuthorizationRequiredError` with `authUrl`. Before, the authorization URL was never shown, and a callback for it was dropped as stale because the connection was still `ready`. See [Re-authorization during a session](https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-client.md#re-authorization-during-a-session).
