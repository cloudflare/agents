---
"agents": patch
---

`PiHarness` keeps its wake job when a step fails, retrying with a backoff up to 10 minutes, and counts a memory-limit reset during the job's wait against the alarm memory-limit breaker. See [How recovery works](https://developers.cloudflare.com/agents/harnesses/pi/#how-recovery-works).
