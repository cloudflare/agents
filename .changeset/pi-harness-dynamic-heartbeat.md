---
"agents": patch
---

`PiHarness` backs off a session's wake heartbeat, up to 10 minutes, while its only work is unchanged background tasks or its dispatches keep failing. See [How recovery works](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi.md#how-recovery-works).
