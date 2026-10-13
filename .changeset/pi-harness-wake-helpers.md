---
"agents": minor
---

`agents/harness/pi` exports `sleepUntil` and `checkpointWakeAt`, so a task can report its own deadline to `wakeAt` through its checkpoint. See [How recovery works](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi.md#how-recovery-works).
