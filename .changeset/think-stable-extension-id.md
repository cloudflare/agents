---
"@cloudflare/think": patch
---

`ExtensionManager` now derives the Dynamic Worker id from a hash of the extension's code and configuration instead of `Date.now()`, so restarting a Think Durable Object no longer creates (and bills) a new Dynamic Worker per extension. See [#2911](https://github.com/cloudflare/agents/issues/2911).
