---
"agents": patch
---

Add cursor-based pagination to `getWorkflows()`. Returns a `WorkflowPage` with workflows, total count, and cursor for next page. Default limit is 50 (max 100).
