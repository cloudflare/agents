---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

Stopping the turn that is running now also drops the auto-continuations that were waiting when the stop landed, in `AIChatAgent` and `Think`, however it is stopped (the client's cancel, `abortRequest`, `abortAllRequests`, `cancelAllChats`, or the `signal` passed to `saveMessages`, `continueLastTurn` or `chat()`): a tool result answered while the reply streamed, or one that arrived while a continuation ran before it was stopped, no longer starts the model again; it stays in the transcript, `chat:continuation:dropped` is emitted with reason `stopped`, and a result that arrives after the stop continues as usual. `Think`'s WebSocket cancel now also aborts a running recovery attempt directly, as `cancelChat` does.
