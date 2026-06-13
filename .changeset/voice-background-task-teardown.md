---
"@cloudflare/voice": patch
---

Stop fire-and-forget voice lifecycle handlers from leaking unhandled rejections
on connection teardown. The `withVoiceInput` mixin dispatches `start_call`,
`end_call`, `interrupt`, and transcript emission from the synchronous
`onMessage` handler without awaiting them, so a client dropping mid-operation
(e.g. while `keepAlive()`'s alarm write is still in flight) could surface a
retryable "Network connection lost." rejection. These background tasks now run
through a teardown-aware helper that swallows expected connection-teardown
errors and logs anything unexpected.
