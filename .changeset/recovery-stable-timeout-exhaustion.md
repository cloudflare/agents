---
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Terminalize a chat-recovery turn through `onExhausted` when it gives up waiting for stable state

Under extreme churn (a long turn interrupted many times in quick succession), a
recovery callback (`_chatRecoveryRetry` / `_chatRecoveryContinue`) could keep
timing out waiting for the isolate to reach stable state until its retry budget
drained. The give-up path only marked the incident `failed` and completed the
recovered submission as `error` — it **bypassed `_exhaustChatRecovery`**, so
`onExhausted` never fired, the `chat:recovery:exhausted` event was not emitted,
the configured `terminalMessage` banner was never delivered, and the terminal
chat status was not recorded. Apps relying on `onExhausted` for the terminal
banner saw an eternal spinner with no terminal signal.

The stable-state-timeout give-up now routes through the **same**
`_exhaustChatRecovery` path as deploy-recovery and stall exhaustion: it fires
`onExhausted` (with `reason: "stable_timeout"`), emits `chat:recovery:exhausted`,
marks the durable submission interrupted, records the terminal chat status, and
delivers the `terminalMessage`. As an extra backstop against silent drops, the
give-up also terminalizes when the incident record is missing (no `incidentId`,
or it was swept/deleted before a stale alarm fired) by synthesizing a terminal
incident from the recovery-root request id — so a turn can never be dropped with
no terminal UX.
