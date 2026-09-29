---
"@cloudflare/think": patch
---

Messenger attachments now load when a `chat` adapter's `fetchData` resolves to a plain `ArrayBuffer`, which `chat` releases inside Think's `^4.31.0` range allow. Previously the conversion read `Buffer`-only fields, so it threw on an `ArrayBuffer` and returned empty bytes for a `Buffer` backed by a `SharedArrayBuffer`.
