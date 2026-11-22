---
"@cloudflare/think": minor
---

Durable submissions keep their records in a new internal store: existing `cf_think_submissions` rows move over on first start, `resetTurnState()` also skips running submissions, an interrupted submission runs at most three times, and `onSubmissionStatus` can run again for a terminal status after a restart cut it short. See [Programmatic submissions](https://github.com/cloudflare/agents/blob/main/docs/think/programmatic-submissions.md).
