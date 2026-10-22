---
"agents": patch
---

MCP client: re-authorization stops after three completed authorizations for the same scopes, per the MCP authorization spec's step-up retry limit; the server is marked `failed` instead of showing another link. See [Re-authorization during a session](https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-client.md#re-authorization-during-a-session).
