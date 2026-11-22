---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

An orphaned reply that continued a stored message is rebuilt onto that message's parts from when its stream started, so rebuilding it twice no longer repeats its parts in `AIChatAgent`.
