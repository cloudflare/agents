---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Internal refactor, no API change: each queued chat turn is one durable run, and its model call runs inside it.
