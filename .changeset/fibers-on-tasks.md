---
"agents": patch
---

Fibers run as Task runs. `runFiber()`, `startFiber()` and the fiber methods are unchanged; a running fiber keeps the agent awake with its own wake instead of a `keepAlive()` ref, a sub-agent's fibers wake through the root, and fiber rows from earlier releases are carried forward on start. See [Durable execution](https://github.com/cloudflare/agents/blob/main/docs/agents/durable-execution.md).
