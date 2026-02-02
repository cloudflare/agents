---
"agents": patch
---

Fix workflow tracking table not being updated by AgentWorkflow callbacks.

Previously, when a workflow reported progress, completion, or errors via callbacks, the `cf_agents_workflows` tracking table was not updated. This caused `getWorkflow()` and `getWorkflows()` to return stale status (e.g., "queued" instead of "running" or "complete").

Now, `onWorkflowCallback()` automatically updates the tracking table:

- Progress callbacks set status to "running"
- Complete callbacks set status to "complete" with `completed_at` timestamp
- Error callbacks set status to "errored" with error details

Fixes #821.
