---
"@cloudflare/ai-chat": patch
---

fix(ai-chat): tighten pending interaction coordination and clear resets

- make `waitForPendingInteractionResolution()` wait for a fully stable conversation state, including queued continuation turns
- add `resetTurnState()` for scoped clear handlers that need to abort active work and invalidate queued continuations
- harden pending-interaction bookkeeping so rejected tool-result and approval applies do not leak as unhandled rejections
