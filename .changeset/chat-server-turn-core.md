---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

`saveMessages`, `continueLastTurn` and the recovery retry in `AIChatAgent` and `Think` run through one shared function: a turn stopped before its model call (an already-aborted `signal`, or `abortAllRequests()` while it waits in the queue) stores its messages and never calls the model.
