---
"agents": patch
---

Fix MCP client races found by TLA+ model checking: a pending step-up link survives a token refresh, a refresh no longer overwrites a step-up grant, a removed server's tokens stay deleted, a sign-in survives `closeConnection()`, an old link no longer fails a server added again, overlapping closes and removals leave a server added again alone, `addMcpServer(..., { id })` returns a link that works and renames the server in one transaction, configuring elicitation handlers while a server connects no longer fails it and is advertised, step-up rounds count for the scope set of the link that was completed, and a declined sign-in after a refused refresh is recorded as failed (see [re-authorization during a session](https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-client.md#re-authorization-during-a-session)).
