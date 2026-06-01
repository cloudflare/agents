---
"@cloudflare/think": minor
---

Route a stream-stall watchdog abort into bounded recovery instead of a terminal error (#1626)

When `chatStreamStallTimeoutMs` is set and the inactivity watchdog fires on a
hung model/transport stream, the turn is no longer failed terminally. Because a
stall is just another interruption — like a deploy or eviction — it is now
routed into the **same bounded chat-recovery path**: the settled partial is
preserved, a continuation is scheduled, and the turn resumes. A transient hang
(the common case under deploy churn) recovers automatically; a persistently
hanging provider still terminalizes once the recovery budget is exhausted (the
watchdog's original "kill the infinite spinner" guarantee, now after bounded
retries). Exhaustion goes through the **same** `_exhaustChatRecovery` path as
deploy-recovery exhaustion, so your configured `terminalMessage` is delivered,
`onExhausted` fires, and the `chat:recovery:exhausted` event is emitted — rather
than leaking the raw `"Chat stream stalled…"` error.

This is automatic whenever the watchdog is enabled and `chatRecovery` is on
(the Think default) — no new configuration. Idempotency matches deploy
recovery: settled tool results are durable and are not re-run, but a tool that
was mid-execution when the stall fired re-runs on the continuation. With
`chatRecovery` disabled, a stall stays terminal as before.

Also adds a per-turn `TurnConfig.chatStreamStallTimeoutMs` override (returned
from `beforeTurn`): a turn known to invoke a slow tool can raise or disable
(`0`) the watchdog for that turn only, instead of permanently widening the
instance-level window. It auto-resets after the turn.
