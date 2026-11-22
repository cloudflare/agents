---
"@cloudflare/think": minor
---

Durable submissions are stored with the `Inbox` capability; existing `cf_think_submissions` rows move over on first start, and a reset now skips running submissions too. See [Programmatic submissions](https://github.com/cloudflare/agents/blob/main/docs/think/programmatic-submissions.md).
