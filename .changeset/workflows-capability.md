---
"agents": patch
---

`approveWorkflow()` and `rejectWorkflow()` no longer go through an overridden `sendWorkflowEvent()`. Otherwise an internal refactor of Agent's workflow methods, with no API change.
