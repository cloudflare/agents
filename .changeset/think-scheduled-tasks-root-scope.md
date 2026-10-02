---
"@cloudflare/think": minor
---

Breaking: declared scheduled tasks now run on the root agent only; override `getScheduledTasksScope()` to return `"all"` for per-facet scheduling. See [Think scheduled tasks](https://github.com/cloudflare/agents/blob/main/docs/think/index.md#scheduled-tasks).
