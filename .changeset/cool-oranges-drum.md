---
"@cloudflare/ai-chat": patch
---

Strip messageId from continuation start chunks server-side so clients reuse the existing assistant message instead of briefly creating a duplicate.
