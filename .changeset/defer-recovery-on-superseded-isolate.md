---
"agents": patch
---

Scheduled callbacks no longer drop their work when an alarm fires on an isolate
that a deploy has just superseded. In that window the first `ctx.storage` op
throws `Durable Object reset because its code was updated.` for the entire
invocation (code never reloads mid-invocation). Previously
`Agent._executeScheduleCallback` burned its in-process retries (all doomed),
swallowed the error, and `alarm()` deleted the one-shot row — permanently
abandoning the work even though the next fresh invocation would succeed. This
was a second deploy-churn abandonment path for chat recovery
(`_chatRecoveryContinue` / `_chatRecoveryRetry`) that the progress-aware budget
in `@cloudflare/think` / `@cloudflare/ai-chat` could not reach, because the
continuation was deleted before it could be re-detected.

For a one-shot schedule failing with this transient, the SDK now skips the
doomed in-process retries and re-throws so `alarm()` rejects: the one-shot row
survives and Cloudflare re-runs the alarm on a fresh isolate (= new code) under
the at-least-once alarm guarantee, so the work auto-resumes once the deploy
settles. All other callbacks and error classes keep the existing behavior.
