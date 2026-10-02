---
"agents": patch
---

`runFiber()` no longer calls `onFiberRecovered()` for work that already finished (#2305). See [Durable execution](https://github.com/cloudflare/agents/blob/main/docs/agents/durable-execution.md).
