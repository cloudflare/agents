---
"agents": patch
---

Route default MCP OAuth callbacks back to the sub-agent facet that started the authorization flow, and let `routeSubAgentRequest()` accept structured descendant paths.
