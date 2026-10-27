---
"agents": patch
---

The `agents()` Vite plugin escapes characters above U+00FF in Worker chunks, so V8 keeps each module's source as a one-byte string. See [Latin-1 Worker Chunks](https://developers.cloudflare.com/agents/api-reference/configuration/#latin-1-worker-chunks).
