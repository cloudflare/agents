---
"agents": patch
---

`ThinkHarness` now keeps its sessions and operations in the shared `agents/harness/store`, and moves records from its old tables on first start so work in flight still recovers. See [ThinkHarness: Recovery](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/think.md#recovery).
