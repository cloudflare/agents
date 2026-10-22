---
"agents": patch
---

Fix `PiHarness` with `onWake` not resuming a sleeping Pi task, such as a compaction retry backoff, while another task is still running. See [#2683](https://github.com/cloudflare/agents/issues/2683).
