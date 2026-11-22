---
"@cloudflare/think": minor
---

Durable submissions are stored with the `Inbox` capability: existing `cf_think_submissions` rows move over on first start, a reset skips running submissions too, and an interrupted submission runs at most three times. See [Programmatic submissions](https://github.com/cloudflare/agents/blob/main/docs/think/programmatic-submissions.md).
