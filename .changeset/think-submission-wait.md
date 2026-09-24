---
"@cloudflare/think": minor
---

Add `waitForSubmission(submissionId, { timeoutMs? })`, which resolves once a durable submission reaches a terminal status and `onSubmissionStatus` has run for it, so a caller such as a Workflow step no longer has to poll `inspectSubmission`. It resolves immediately for a finished submission and with `null` for an unknown id. On timeout it returns the submission's current state.

`cancelSubmission()` now returns what it did: `{ outcome: "cancelled", previousStatus, messagesApplied, submission }`, `{ outcome: "already_terminal", submission }` or `{ outcome: "not_found" }`. `previousStatus` tells a submission removed before its turn started (`"pending"`) from one whose turn had been claimed (`"running"`), and `messagesApplied` says whether its messages reached the conversation. It previously returned `void`.
