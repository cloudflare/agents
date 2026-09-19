---
"agents": patch
---

`StreamWriter.onCommit(fn)` registers synchronous callbacks to run inside the stream's settle transaction, for code that holds the writer but does not own the `close()` call. Callbacks run in registration order, before the `commit` passed to `close()`/`error()`, under the same contract — no awaiting, and a throw rolls the settle back and leaves the stream live — and only for the call that ends the stream. The set is fixed when `close()`/`error()` is called, `onCommit` returns an unregister function, and registrations belong to the writer object rather than the stream: reopening a live stream returns a fresh writer with none, and a writer stops accepting registrations once its own call has settled the stream.

A writer with callbacks registered settles through the transaction path rather than the cheaper non-transactional one; writers that never call `onCommit` keep their current cost.
