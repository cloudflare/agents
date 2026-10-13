---
"agents": patch
---

`PiHarness` keeps a session's wake job when its dispatch fails through its retries, instead of letting Lifecycle complete it. See [How recovery works](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi.md#how-recovery-works).
