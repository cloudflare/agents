---
"@cloudflare/ai-chat": patch
---

Fix tool continuation streams so they keep updating the existing assistant message instead of briefly creating a duplicate.
