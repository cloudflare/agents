---
"agents": patch
---

With `wakeAt` set, `PiHarness` leaves pi paused at startup while every live task sleeps until a known deadline, so the object can hibernate until its alarm. See [How recovery works](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi.md#how-recovery-works).
