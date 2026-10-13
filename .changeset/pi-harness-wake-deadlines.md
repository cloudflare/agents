---
"agents": patch
---

`PiHarness` no longer parks a session's wake on a generation's retry or poll deadline while the session has other live work. See [How recovery works](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi.md#how-recovery-works).
