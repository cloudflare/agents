---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

`AIChatAgent` and `Think` settle unanswered tool calls before a turn the same way: a new message now fails a client tool call or approval request left pending in an earlier reply (`AIChatAgent` used to keep it, and the provider rejected the request), a continuation turn keeps the calls a client can still answer in the message it continues (`Think` used to fail them), and a `Think` request that sends no `clientTools` clears the stored ones.
