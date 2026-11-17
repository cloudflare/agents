---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

`saveMessages`, `continueLastTurn` and the recovery retry in `AIChatAgent` and `Think` run through one shared function: a turn stopped before it starts stores nothing, never calls the model and fires no `onChatResponse`; a chat clear gives `skipped`; the turn runs with the tools and body stored when it starts; `abortAllRequests()` stops every reply, queued or waiting on `onChatMessage`; and `Think` recovers a context overflow on continued and retried turns too, reporting a turn stopped meanwhile as `aborted`.
