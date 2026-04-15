---
"@cloudflare/ai-chat": patch
"hono-agents": patch
"@cloudflare/voice": patch
---

Publish with correct peer dependency ranges for `agents` (wide ranges were being overwritten to tight `^0.x.y` by the pre-publish script)
