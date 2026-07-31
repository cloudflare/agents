---
"agents": patch
---

Automatically report successful `AgentWorkflow` completion and its returned result to the originating Agent. Workflows no longer need to call `step.reportComplete()` for Agent lifecycle callbacks and tracking to stay synchronized.
