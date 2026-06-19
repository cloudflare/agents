---
"@cloudflare/think": minor
---

Add DO chat recovery to `step.prompt()` retry loop.

When a prompt wait times out (e.g. the Think Durable Object died during a deploy), the retry loop now checks whether the DO's built-in chat recovery has picked up the interrupted submission before cancelling and re-submitting. If the submission is still `pending` or `running` (recovery in progress) or already `completed`, the workflow re-waits for the original completion event instead of wasting the in-flight turn.

This leverages Think's existing `_recoverSubmissionsOnStart()` and fiber recovery mechanisms — no new RPC is needed (`inspectSubmission` already exists). The workflow uses a single event type across all retry attempts so the recovered submission's completion event reaches any retry's `waitForEvent`.

Recovery is only attempted for `ThinkPromptTimeoutError` with `retryOnTimeout` enabled. Non-timeout errors (provider errors, validation failures) still go through the existing cancel + full retry path. If the recovery re-wait also times out, the loop falls through to cancel + full retry (no infinite recovery loop).
