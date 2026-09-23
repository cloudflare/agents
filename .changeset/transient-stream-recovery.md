---
"@cloudflare/think": patch
"agents": patch
---

Route stream errors that `classifyChatError` marks `"transient"` or `"rate_limit"` into bounded chat recovery instead of ending the turn. Both thrown errors and in-stream error chunks take the same path as a stream stall (`onChatRecovery`, `chatRecovery.maxAttempts`, then the exhaustion message), and the continuation is delayed with exponential backoff (1 second, doubling, capped at 30 seconds). Without a `classifyChatError` override, behavior is unchanged.

A recovery attempt that is interrupted again and schedules the next attempt no longer marks the incident `failed` or finishes the durable submission as `aborted`; the scheduled attempt owns the outcome. That attempt is enqueued with the new `"chained_retry"` schedule reason, so it never joins the attempt that scheduled it. A durable submission whose turn is handed to recovery stays `running` until recovery finishes it, instead of being marked `aborted`.
