---
"agents": patch
---

`Lifecycle.fetch` no longer sends an error's stack to the client when startup or a request handler throws. HTTP requests get a generic `Internal Server Error` body and WebSocket upgrades close with 1011 without an error frame. The full error is still logged. See [#2828](https://github.com/cloudflare/agents/issues/2828).
