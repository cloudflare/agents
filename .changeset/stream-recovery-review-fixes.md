---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Harden live stream-error recovery in `@cloudflare/think` and `@cloudflare/ai-chat`:

- A failure after the stream finished (for example, persisting the message) stays terminal instead of retrying a completed turn, and `onChatResponse` fires once.
- An aborted turn is never classified as transient and retried.
- A cancel that lands while a recovery waits out its backoff now cancels the scheduled recovery.
- A failure while routing into recovery still delivers the terminal error.
- Stalls count toward the transient retry budget, so a turn that streams a little and stalls on every attempt terminates.
- `classifyChatError` receives the original provider error for in-stream errors, not only its text.
- A `rate_limit` with a `Retry-After` header waits at least that long (capped at 60 seconds).
- Think never schedules live recovery for Durable Object code-update or storage resets.
- ai-chat honors `onChatRecovery`'s `persist: false` on live recovery, and a chained recovery attempt no longer marks its incident failed or joins the run that scheduled it.
- Recovered messenger replies are delivered at most once per post and retried when live delivery fails.

`agents/chat` exports `chatRecoveryBackoffSeconds`, `retryAfterSeconds`, `isDurableObjectResetError` and `partialHasSettledToolResults` for these paths.
