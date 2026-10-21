---
"agents": patch
---

Lifecycle arms a fallback alarm while its job queue holds jobs, before startup runs in an alarm and after a startup that queued jobs throws, so a failed startup cannot leave queued jobs without a wake. See [Lifecycle](https://github.com/cloudflare/agents/blob/main/docs/agents/lifecycle.md).
