---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

`AIChatAgent` and `Think` settle unanswered tool calls before a turn the same way: a new message fails a client tool call, approval request or approved call left pending in an earlier reply (`AIChatAgent` used to keep it and the provider rejected the request), `continueLastTurn()` returns `skipped` without calling the model while the reply still waits on a client, a `Think` request that sends no `clientTools` clears the stored ones, and `AIChatAgent` now emits `chat:transcript:repaired` like `Think`. See [Client-side tools](https://github.com/cloudflare/agents/blob/main/docs/agents/client-tools-continuation.md#when-the-user-moves-on-without-answering).
