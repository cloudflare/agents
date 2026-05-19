---
"@cloudflare/think": patch
---

Expose additive `TurnConfig.stopWhen` conditions so Think subclasses can end an agentic loop early, for example after a designated tool call, while retaining the existing `maxSteps` safety bound.
