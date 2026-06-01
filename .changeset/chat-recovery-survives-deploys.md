---
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Chat recovery no longer permanently abandons a turn under repeated deploys. A
mid-turn deploy resets the Durable Object ("code was updated") and the
interrupted continuation is re-detected on the next wake; previously every such
interruption consumed one of the bounded recovery attempts, so a deploy every
few minutes exhausted the budget (`max_attempts_exceeded`) and the turn was
terminally abandoned even though each fresh isolate was healthy. Recovery now
distinguishes an interruption that followed forward progress (more persisted
assistant content than the previous attempt observed) — treated as environmental
and not counted against the budget — from a turn that never advances, which still
exhausts at `maxAttempts`. A 15-minute wall-clock ceiling per incident bounds the
worst case so a continuously churning environment cannot retry forever.
