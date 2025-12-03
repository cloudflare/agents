---
"agents": patch
---

Enables connecting to multiple MCP servers simultaneously and hardens OAuth state handling against replay/DoS attacks.

**Note:** Inflight OAuth flows that were initiated on a previous version will not complete after upgrading, as the state parameter format has changed. Users will need to restart the authentication flow.
