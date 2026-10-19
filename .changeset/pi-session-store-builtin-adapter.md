---
"agents": patch
---

`openPiSessionStore` now uses pi-durable's own Durable Object SQLite adapter, so several Pi storages in one object share its operation queue. See [Pi harness](https://developers.cloudflare.com/agents/harnesses/pi/).
