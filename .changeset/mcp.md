---
"agents": patch
---

MCP, email and stubs after a reset.

- The MCP client checks server URLs with the same rules as `web_fetch` on every request, and now refuses more private and reserved addresses, `.internal` names and URLs with credentials; loopback stays allowed. See [URL security](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/#url-security).
- `AgentWorkflow`, the MCP RPC transport and `getAgentByName` recover from an Agent reset instead of failing every later call (#2978).
- `replyToEmail()` no longer adds a second `Re:` to a subject, and `isAutoReplyEmail()` ignores spaces around a header's value (#3207).
