---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

`saveMessages`, `continueLastTurn` and the recovery retry in `AIChatAgent` and `Think` run through one shared function: a turn stopped before it starts (an already-aborted `signal`, or `abortAllRequests()` while it waits in the queue) stores nothing and never calls the model. `onChatResponse` does not fire for such a turn; the `aborted` status is in the value `saveMessages` returns.
