---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

A `saveMessages`, `continueLastTurn` or retry turn runs with the tools and body stored when it starts, not when it was queued; `abortAllRequests()` now stops every `AIChatAgent` reply, including one whose `onChatMessage` was still pending; and `Think` recovers a context overflow (`contextOverflow.reactive`) during `continueLastTurn` and the recovery retry too.
