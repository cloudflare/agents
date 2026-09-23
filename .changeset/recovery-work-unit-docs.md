---
"agents": patch
---

Correct the `ChatRecoveryConfig.maxRecoveryWork` and `ChatRecoveryProgressContext.work` documentation: the default is `10000`, and the unit is a durable stream segment (roughly ten packed streaming chunks, one settled tool result, or one forwarded sub-agent credit), not a "content/tool unit". Values set explicitly before #2223 are not recalibrated, so re-measure `ctx.work` before carrying one forward.
