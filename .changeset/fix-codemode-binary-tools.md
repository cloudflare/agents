---
"@cloudflare/codemode": patch
"@cloudflare/shell": patch
---

Preserve binary values across codemode tool calls so `Uint8Array` arguments and results survive the sandbox boundary. This fixes `state.writeFileBytes()` from codemode with byte arrays and keeps `readFileBytes()` results as `Uint8Array` values.
