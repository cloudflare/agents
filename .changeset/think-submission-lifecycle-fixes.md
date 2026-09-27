---
"@cloudflare/think": patch
---

Fix several submission and turn lifecycle edge cases in Think:

- `waitForSubmission()` now throws a clear error when called from inside an active turn or from `onSubmissionStatus` for a submission that cannot settle until the caller returns, instead of hanging.
- Cancelling a running submission emits its terminal status once, and a cancel that arrives during the `running` status hook aborts the submission.
- Submissions skipped by `resetTurnState()` are visible to `waitForSubmission()` only after their status hook runs.
- `activeChannel` is scoped to the admitted turn, so work a tool leaves behind no longer sees a later turn's channel.
- The channel used for continuations is recorded only once a submission's turn actually runs inference, and is cleared by `resetTurnState()`.
- Rejecting a paused tool with `autoContinue: false` mid-stream drops the stale pending-state generation once the parking turn ends.
- Dropping the generation after a resolved pause keeps text from later steps that answered other tools.
