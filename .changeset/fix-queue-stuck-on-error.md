---
"agents": patch
---

Fix `_flushQueue()` permanently blocking when a queued callback throws

A throwing callback in `_flushQueue()` previously caused the failing row to never be dequeued, creating an infinite retry loop that blocked all subsequent queued tasks. Additionally, `_flushingQueue` was never reset to `false` on error, permanently locking the queue for the lifetime of the Durable Object instance.

The fix wraps each callback invocation in try-catch-finally so that failing items are always dequeued and subsequent items continue processing. The `_flushingQueue` flag is now reset in a top-level finally block. Missing callbacks are also dequeued instead of being skipped indefinitely.

**Note for existing stuck Durable Objects:** This fix is self-healing for poison rows — they will be properly dequeued on the next `_flushQueue()` call. However, `_flushQueue()` is only triggered by a new `queue()` call, not on DO initialization. If you have DOs stuck in production, you can either trigger a new `queue()` call on affected DOs, or call `dequeueAll()`/`dequeueAllByCallback()` to clear the poison rows manually. A future improvement may add a `_flushQueue()` call to `onStart()` so stuck DOs self-heal on wake.
