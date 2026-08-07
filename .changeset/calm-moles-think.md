---
"@cloudflare/think": patch
---

Record orphaned durable execution outcomes as user context so provider transcript validation cannot reject arbitrarily placed fallback notes. Existing system-role outcome notes are converted to user context for inference without rewriting stored history.
