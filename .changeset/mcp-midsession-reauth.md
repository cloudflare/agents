---
"agents": patch
---

MCP client: requests that need re-authorization (scope step-up or a failed token refresh) throw `MCPAuthorizationRequiredError` and move the server to `authenticating`; `addMcpServer()` returns `authenticating` when discovery needs OAuth and waits for in-flight connections instead of reporting them `ready`; restored servers no longer serve expired authorization links. See [Re-authorization during a session](https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-client.md#re-authorization-during-a-session).
