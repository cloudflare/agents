---
"@cloudflare/ai-chat": patch
---

fix(ai-chat): simplify turn coordination API

- rename `waitForPendingInteractionResolution()` to `waitUntilStable()` and make it wait for a fully stable conversation state, including queued continuation turns
- add `resetTurnState()` for scoped clear handlers that need to abort active work and invalidate queued continuations
- demote `isChatTurnActive()`, `waitForIdle()`, and `abortActiveTurn()` to private — their behavior is subsumed by `waitUntilStable()` and `resetTurnState()`
- harden pending-interaction bookkeeping so rejected tool-result and approval applies do not leak as unhandled rejections
