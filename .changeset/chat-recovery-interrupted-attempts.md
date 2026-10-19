---
"agents": patch
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Stop chat recovery from looping forever when a turn exceeds the Durable Object memory limit on every run. The isolate that hits the limit cannot write anything, so the old out-of-memory counters never moved past one. Recovery now counts each interrupted attempt when the next isolate picks the turn up, before it re-runs anything, and seals the turn with `interrupted_attempts_exceeded` after `chatRecovery.maxInterruptedAttempts` attempts (default 5, the original turn included). Streamed output does not reset the count.

The count does not know why an attempt died, so a turn interrupted by five deploys in a row is also sealed. `maxOomRetries` is deprecated and read as `maxInterruptedAttempts: maxOomRetries + 1`. The alarm breaker's log now says when it could not count a strike instead of always printing `strike 1/3`. See [#2613](https://github.com/cloudflare/agents/issues/2613); thanks @ShubhamVsCode.
