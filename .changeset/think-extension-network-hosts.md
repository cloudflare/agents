---
"@cloudflare/think": patch
---

An extension's `permissions.network` hosts are now enforced when the Worker re-exports `HostBridgeLoopback`: a request to an unlisted host or a private address gets a `403`. See [Tools](https://developers.cloudflare.com/agents/harnesses/think/tools/).
