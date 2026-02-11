---
"agents": patch
---

Fix `_flushQueue()` permanently blocking when a queued callback throws

A throwing callback in `_flushQueue()` previously caused the failing row to never be dequeued, creating an infinite retry loop that blocked all subsequent queued tasks. Additionally, `_flushingQueue` was never reset to `false` on error, permanently locking the queue for the lifetime of the Durable Object instance.

The fix wraps each callback invocation in try-catch-finally so that failing items are always dequeued and subsequent items continue processing. The `_flushingQueue` flag is now reset in a top-level finally block. Missing callbacks are also dequeued instead of being skipped indefinitely.
