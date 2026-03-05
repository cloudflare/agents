---
"agents": patch
---

Fix missing `await` on `_workflow_updateState` RPC calls in `AgentWorkflow._wrapStep()` for `updateAgentState`, `mergeAgentState`, and `resetAgentState`, which could cause state updates to be silently lost.
