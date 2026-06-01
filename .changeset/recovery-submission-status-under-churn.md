---
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Fix chat recovery falsely marking a durable submission as `error` under repeated mid-turn deploys.

When several deploys interrupt a single turn, recovery runs a _chain_ of continuations. Three bugs combined to leave the submission in `error` even when the turn actually completed every step:

- **Lost ownership.** The submission link (`recoveredRequestId`) was derived from each continuation's own (fresh) requestId, so chained continuations dropped it — the continuation that finally completed the turn could no longer mark the submission `completed`.
- **Stale-continuation clobber.** A superseded continuation tripped the `conversation_changed` guard because the leaf had advanced via recovery's _own_ forward progress (a new assistant message), not a new user turn, and overwrote the still-running submission to `error`.
- **Premature `stable_timeout`.** A timeout while waiting for the isolate to settle (common while a deploy is in flight) failed the turn terminally at the first attempt.

Now: submission ownership is keyed off the stable recovery root and threaded through the entire continuation chain (including the terminal abandon paths — recovery exhaustion and `{ continue: false }` — which previously marked the submission by the per-continuation requestId and so left a chained submission stuck `running`); a superseded continuation skips benignly (only a genuinely newer user turn marks the submission `skipped`, never `error`); and a stable-state timeout reschedules within the `maxAttempts` budget. A turn that completes under deploy churn now ends `completed`, not `error`.

`@cloudflare/ai-chat` has the same recovery machinery but no durable-submission layer, so it receives the `stable_timeout` reschedule fix only: a transient stable-state timeout now retries within the attempt budget instead of permanently abandoning a recoverable turn at the first attempt.
