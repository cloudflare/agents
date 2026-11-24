---
"agents": patch
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Internal refactor, no API change: a chat turn found interrupted after a restart runs its recovery attempt in its own durable run.
