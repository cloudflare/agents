---
"@cloudflare/think": patch
"agents": patch
---

Route stream errors that `classifyChatError` marks `"transient"` or `"rate_limit"` into bounded chat recovery instead of ending the turn. Both thrown errors and in-stream error chunks take the same path as a stream stall (`onChatRecovery`, `chatRecovery.maxAttempts`, then the exhaustion message), and the continuation is delayed with exponential backoff (1 second, doubling, capped at 30 seconds). Without a `classifyChatError` override, behavior is unchanged.
