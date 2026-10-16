---
"agents": patch
---

`PiHarness` passes errors from a session's idle wait to the tracked alarm work, so Lifecycle's memory-limit breaker sees a reset there. See [How recovery works](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi.md#how-recovery-works).
