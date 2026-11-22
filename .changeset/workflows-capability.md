---
"agents": patch
---

Agent's workflow methods (`runWorkflow()`, `getWorkflows()`, `approveWorkflow()` and the rest) run on an internal `Workflows` capability that owns `cf_agents_workflows`; `approveWorkflow()` and `rejectWorkflow()` no longer go through an overridden `sendWorkflowEvent()`.
