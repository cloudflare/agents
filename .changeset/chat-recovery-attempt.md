---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

`AIChatAgent` and `Think` run a chat recovery attempt through one shared sequence. A recovery no longer continues a reply that a client's tool result already continued (the incident ends `skipped` with `continued_by_interaction`), an attempt that throws ends with `onExhausted` (`recovery_error`) in `AIChatAgent` too, a stop always ends the incident as `user_cancelled`, and an incident that gave up is no longer marked failed.
