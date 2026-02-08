---
"agents": minor
---

Upgrade MCP SDK to 1.26.0 to prevent cross-client response leakage. Updated examples for stateless MCP Servers create new `McpServer` instance per request instead of sharing a single instance. A guard is added in this version of the MCP SDK which will prevent connection to a Server instance that has already been connected to a transport. Developers will need to modify their code if they declare their `McpServer` instance as a global variable.
