---
"agents": patch
---

Fix `PiHarness` with `onWake` not resuming a sleeping Pi task, such as a compaction retry, while another task is running ([#2683](https://github.com/cloudflare/agents/issues/2683)). See [How recovery works](https://developers.cloudflare.com/agents/harnesses/pi/#how-recovery-works).
