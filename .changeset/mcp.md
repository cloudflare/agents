---
"agents": patch
---

MCP, email and models.

- The MCP client checks server URLs like `web_fetch`, refusing more private addresses, `.internal` names and URLs with credentials.
- `AgentWorkflow`, the MCP RPC transport and `getAgentByName` recover from an Agent reset (#2978).
- `replyToEmail()` no longer adds a second `Re:` (#3207).
- `agents/models/pi-ai`: an `AbortError` from `onResponse` on Anthropic stops a fallback chain.
