---
"agents": patch
---

`import {context} from 'agents';`

Export the current agent, request, and connection from a shared context. Particularly useful for tool calls that might not have access to the current agent in their module scope.
