---
"agents": minor
---

Add retry utilities: `this.retry()`, per-task retry options, and `RetryOptions` type

- `this.retry(fn, options?)` — retry any async operation with exponential backoff and jitter. Accepts optional `shouldRetry` predicate to bail early on non-retryable errors.
- `queue()`, `schedule()`, `scheduleEvery()` accept `{ retry?: RetryOptions }` for per-task retry configuration, persisted in SQLite alongside the task.
- `addMcpServer()` accepts `{ retry?: RetryOptions }` for configurable MCP connection retries.
- `RetryOptions` type is exported for TypeScript consumers.
- Retry options are validated eagerly at enqueue/schedule time — invalid values throw immediately.
- Class-level retry defaults via `static options = { retry: { ... } }` — override defaults for an entire agent class.
- Internal retries added for workflow operations (`terminateWorkflow`, `pauseWorkflow`, etc.) with Durable Object-aware error detection.
