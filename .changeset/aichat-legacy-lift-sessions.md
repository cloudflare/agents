---
"agents": patch
"@cloudflare/ai-chat": patch
---

Internal refactor, no API change: `AIChatAgent`'s pre-Sessions message table is lifted by Sessions on start, as Think's legacy tables already are.
