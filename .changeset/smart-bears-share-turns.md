---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Share submit concurrency bookkeeping through `agents/chat` and use it from both chat agents.

This extracts the `latest`/`merge`/`drop`/`debounce` admission state machine into a `SubmitConcurrencyController` exported from `agents/chat`. `AIChatAgent` semantics (including merge persistence) are preserved. `Think` now picks up the same pending-enqueue protection, so an overlapping submit is still detected while an accepted request is between admission and turn queue registration.

Additional fixes:

- `Think` now captures the turn generation immediately after admission and threads it into `_turnQueue.enqueue`, so a clear that lands between admission and queue registration cannot run a stale turn.
- Pending-enqueue tracking is now bound to a release function tied to the controller's reset epoch, so a release from a pre-reset submit can no longer erase a post-reset submit's marker and let a third submit slip through as non-overlapping.
- Debounce cancellation correctly resolves all in-flight waiters instead of overwriting a single timer slot.
