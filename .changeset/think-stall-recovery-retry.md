---
"@cloudflare/think": patch
---

Fix two gaps in stream-stall recovery (`chatStreamStallTimeoutMs`).

- A stall before the model's first chunk now retries the unanswered user message. Previously Think scheduled a continuation with no assistant message to continue, which was silently skipped and left the turn with no answer and no terminal hook. The same applies when the partial holds only internal parts that are not persisted, such as a structured-output final answer.
- `onChatRecovery` now runs for stalls, as it already did for deploy and eviction recovery. It receives the live turn's latest `stash()` data and start time. `{ continue: false }` ends the turn as interrupted, and `{ persist: false }` discards the partial unless it holds settled tool results. If the hook throws, the incident is marked `failed` and the stall surfaces as a terminal error.

The `StreamCallback` docs now explain that a `chat()` caller bridging to an HTTP response must also close it in `onInterrupted()`.
