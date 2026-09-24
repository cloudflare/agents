---
"@cloudflare/think": minor
---

Add `waitForSubmission(submissionId, { timeoutMs? })`, which resolves once a durable submission reaches a terminal status, so a caller such as a Workflow step no longer has to poll `inspectSubmission`. It resolves immediately for a finished submission and with `null` for an unknown id.

`cancelSubmission()` now returns what it did: `{ outcome: "cancelled", previousStatus, submission }`, `{ outcome: "already_terminal", submission }` or `{ outcome: "not_found" }`. `previousStatus` tells a submission removed before its turn started (`"pending"`) from one whose running turn was aborted (`"running"`). It previously returned `void`.
