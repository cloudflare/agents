---
"@cloudflare/think": patch
---

Add optional retries to `ThinkWorkflow.step.prompt()`.

`step.prompt()` now accepts a `retries` option with `{ maxAttempts?, baseDelayMs?, maxDelayMs? }`. When a prompt fails for any reason, the workflow waits with jittered exponential backoff and submits a fresh prompt attempt, mirroring the default behavior of `step.do()` retries. All prompt failures are retried up to `maxAttempts` (including the first attempt).

Retry state is durable: each attempt uses unique workflow step names and idempotency keys, so retries survive workflow hibernation and replays.
