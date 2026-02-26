---
"agents": patch
---

Fix: `throw new Error()` in AgentWorkflow now triggers `onWorkflowError` on the Agent

Previously, throwing an error inside a workflow's `run()` method would halt the workflow but never notify the Agent via `onWorkflowError`. Only explicit `step.reportError()` calls triggered the callback, but those did not halt the workflow.

Now, unhandled errors in `run()` are automatically caught and reported to the Agent before re-throwing. A double-notification guard (`_errorReported` flag) ensures that if `step.reportError()` was already called before the throw, the auto-report is skipped.
