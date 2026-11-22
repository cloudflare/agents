---
"agents": patch
---

A running fiber (`runFiber()`, `startFiber()`) keeps the agent awake with its own recovery alarm instead of a `keepAlive()` ref, and a sub-agent's fiber recovery is routed through the root instead of the `cf_agents_facet_runs` index. No API change. See [Durable execution](https://github.com/cloudflare/agents/blob/main/docs/agents/durable-execution.md).
