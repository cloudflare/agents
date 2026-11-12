---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

Stopping a reply now also drops the auto-continuation that was waiting on it, in `AIChatAgent` and `Think`: a tool result answered while the reply streamed, or one that arrived while a stopped continuation ran, no longer starts the model again after the stop; it stays in the transcript for the next turn.
