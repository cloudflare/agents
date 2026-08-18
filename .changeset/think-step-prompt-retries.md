---
"@cloudflare/think": patch
---

Add optional retries to `ThinkWorkflow.step.prompt()`.

`step.prompt()` now accepts a `retries` option with `{ maxAttempts?, baseDelayMs?, maxDelayMs?, retryOnTimeout? }`. When a prompt fails for any reason, the workflow waits with jittered exponential backoff and submits a fresh prompt attempt, mirroring the default behavior of `step.do()` retries. All prompt failures are retried up to `maxAttempts` (including the first attempt). Set `retryOnTimeout: false` to fail fast on a wait timeout instead of retrying (timeouts often repeat).

Retry state is durable: each retry uses unique workflow step names and idempotency keys, so retries survive workflow hibernation and replays. The first attempt keeps the original (`:submit`/`:wait`) step names so in-flight workflows from earlier versions continue to replay without re-executing completed steps.

Before retrying, the workflow cancels the abandoned attempt's submission. Think keeps its own `chatRecovery` running for the submission (which preserves in-flight turn state across DO restarts/stalls), so without this a lingering turn or recovery continuation for the old attempt could keep running and race the fresh attempt on the same session — producing duplicate or interleaved output. Each retry is also logged via `console.warn` with the step name, attempt, backoff delay, and error.
