---
"agents": patch
---

Fix MCP OAuth callback URL leaking instance name

Add `callbackPath` option to `addMcpServer` to prevent instance name leakage in MCP OAuth callback URLs. When `sendIdentityOnConnect` is `false`, `callbackPath` is now required — the default callback URL would expose the instance name, undermining the security intent. Also fixes callback request detection to match via the `state` parameter instead of a loose `/callback` URL substring check, enabling custom callback paths.
