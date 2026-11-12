---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

An auto-continuation turn runs and settles one way in `AIChatAgent` and `Think`: a stop reaches it while it waits in the queue, it never continues a reply that already went on to its answer, and a tool result that arrives while one fails still gets its own continuation.
