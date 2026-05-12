---
"@cloudflare/codemode": patch
---

Add a browser-safe codemode export with an iframe sandbox executor and browser
tool helper. Harden iframe message handling with nonce-scoped messages, reject
sanitized tool name collisions, and keep tools with `needsApproval: false`.
