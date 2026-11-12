---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

Stopping the reply that is running now also drops the auto-continuations that were waiting when the stop landed, in `AIChatAgent` and `Think`: a tool result answered while the reply streamed, or one that arrived while a continuation ran before it was stopped, no longer starts the model again; it stays in the transcript for the next turn, and a result that arrives after the stop continues as usual.
