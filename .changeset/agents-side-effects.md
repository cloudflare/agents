---
"agents": patch
---

Mark the package side-effect free (apart from the CLI), so bundlers drop the modules a Worker doesn't use. `import { routeAgentRequest } from "agents"` no longer bundles the MCP client.
