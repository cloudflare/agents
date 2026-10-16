---
"agents": patch
---

Lifecycle arms a fallback alarm before startup in an alarm invocation while its job queue holds jobs, so a failing startup cannot leave queued jobs without a wake. See [docs/agents/lifecycle.md](https://github.com/cloudflare/agents/blob/main/docs/agents/lifecycle.md).
