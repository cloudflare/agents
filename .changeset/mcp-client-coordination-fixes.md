---
"agents": patch
---

Fix MCP client races found by TLA+ model checking: a pending step-up link survives a token refresh, a refresh no longer overwrites a step-up grant, a removed server's tokens stay deleted, a sign-in survives `closeConnection()`, an old link no longer fails a server added again, `addMcpServer(..., { id })` returns a link that works, and configuring elicitation handlers while a server connects no longer fails it.
