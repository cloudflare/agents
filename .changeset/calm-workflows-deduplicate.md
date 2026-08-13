---
"agents": minor
---

Add active-lifetime idempotency keys to `runWorkflow()` so concurrent calls can reuse one Workflow instance without blocking Durable Object concurrency.
