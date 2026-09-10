---
"@cloudflare/think": patch
---

Pass proactively compacted messages to `beforeStep` so hooks that append context do not restore the original history. Explicit message overrides still take precedence.
