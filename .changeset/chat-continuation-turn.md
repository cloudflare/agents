---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

An auto-continuation turn runs, fails and settles one way in `AIChatAgent` and `Think`: a stop reaches it while it waits in the queue, it never continues a reply that already went on to its answer, a tool result that arrives while one fails still gets its own continuation, and a failure before the stream records the terminal status before the error frame and emits `message:error` in `AIChatAgent`.
