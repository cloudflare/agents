---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

`AIChatAgent` and `Think` run chat recovery through one shared sequence. A recovery no longer continues a reply that a client's tool result already continued (the incident ends `skipped` with `continued_by_interaction`), an attempt that throws ends with `onExhausted` (`recovery_error`) in `AIChatAgent` too, a stop always ends the incident as `user_cancelled`, an incident that gave up is no longer marked failed, a turn that is interrupted while another turn's recovery waits now gets its own incident instead of being filed as a later attempt of that recovery, a transient stream error that reaches recovery waits as long as the provider's `Retry-After` or `retry-after-ms` asks (up to 60 seconds), and in `Think` a live interruption that `onChatRecovery` declines to continue now ends the turn with the stream's own error instead of a generic message.
