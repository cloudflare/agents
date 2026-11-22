---
"@cloudflare/ai-chat": patch
---

Internal refactor, no API change: `AIChatAgent` sends its chat frames through the shared frame sender directly.
