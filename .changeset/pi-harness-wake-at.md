---
"agents": minor
---

`PiHarness` takes `wakeAt(task)`, so a session sleeps until its tasks' next deadline instead of polling them. See [How recovery works](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi.md#how-recovery-works).
