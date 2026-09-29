---
"@cloudflare/think": patch
---

A `step.prompt()` turn interrupted mid-stream now recovers and completes with its structured output instead of failing with `ThinkPromptSkippedError` (#1727). Recovery retries a turn cut off inside its final answer, since that partial persists nothing to continue from. Retried and continued turns now keep the structured output tool and capture its result.
