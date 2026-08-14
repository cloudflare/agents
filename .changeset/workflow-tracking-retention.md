---
"agents": patch
---

Passing `retention` to `Agent.runWorkflow(...)` both sends [`retention`](https://developers.cloudflare.com/workflows/build/workers-api/#workflowinstancecreateoptions) unchanged to the underlying Workflow instance and automatically cleans up the Agent's SQLite store.
