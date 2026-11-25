---
"@cloudflare/think": patch
"agents": patch
---

`Think` builds sandboxed extensions' tools and runs their hooks through the internal extension core. A context block's `type` in an extension manifest is now ignored, with a warning.
