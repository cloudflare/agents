---
"agents": patch
---

`runFiber()` and `startFiber()` run on an internal `Fibers` capability that owns its recovery alarm; a running fiber no longer takes a `keepAlive()` ref, and a sub-agent's fiber recovery is routed through the root instead of the `cf_agents_facet_runs` index. See [Durable execution](https://github.com/cloudflare/agents/blob/main/docs/agents/durable-execution.md).
