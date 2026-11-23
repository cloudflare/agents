---
"agents": patch
---

An `AgentWorkflow` run survives an Agent reset between steps: a `reportProgress()` or other callback sent outside a step is made once more on the renewed stub instead of failing the run (#1918).
