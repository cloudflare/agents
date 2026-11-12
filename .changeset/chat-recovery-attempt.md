---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

`AIChatAgent` and `Think` run a chat recovery attempt through one shared sequence: an attempt that throws now ends with `onExhausted` (`recovery_error`) in `AIChatAgent` too, a stop wins over an error thrown after it, and an incident that gave up is no longer marked failed.
