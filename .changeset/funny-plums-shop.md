---
"@cloudflare/ai-chat": patch
---

Prevent hibernation from silently dropping tool auto-continuations. Wrap `_queueAutoContinuation` in `keepAliveWhile` so the DO stays alive from the moment a continuation is queued until it finishes streaming. Also adds test coverage for continuation edge cases.
