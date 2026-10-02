---
"@cloudflare/think": patch
---

Add `waitForSubmission()` for durable submissions and harden cancellation, status-hook, reset-turn, and paused-tool lifecycle handling so waits settle and terminal status is reported once. See [Programmatic submissions](https://github.com/cloudflare/agents/blob/main/docs/think/programmatic-submissions.md).
