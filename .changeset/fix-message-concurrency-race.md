---
"@cloudflare/ai-chat": patch
---

Fix race condition in `messageConcurrency` where rapid overlapping submits could bypass the `latest`/`merge`/`debounce` strategy. The concurrency decision checked `queuedCount()` before the turn was enqueued, but an intervening `await persistMessages()` allowed a second message handler to see a stale count of zero and skip supersede checks. A pending-enqueue counter now bridges this gap so overlapping submits are always detected.
