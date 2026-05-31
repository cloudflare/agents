---
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Stop chat recovery from discarding settled work when a turn is given up on
(#1631).

Two paths could throw away a partial assistant message containing completed,
often non-idempotent tool results:

- When the framework's own recovery budget was exhausted, `_exhaustChatRecovery`
  sealed the turn (terminal status + banner) **before** the orphaned stream was
  ever persisted — so every settled tool result the turn had produced was lost
  and the model re-ran them on the next message. Exhaustion now persists the
  settled partial first, using the same gating as the normal recovery path so it
  can't duplicate an already-saved partial.
- A subclass `onChatRecovery` returning `{ persist: false }` to stop a turn used
  to silently drop the settled partial. Settled work is now **never** dropped:
  `persist: false` only suppresses persistence of a partial that has nothing
  settled to lose; a partial carrying settled tool results is persisted
  regardless. An app can no longer accidentally discard completed work — and it
  never needs `{ persist: true }` just to stay safe. (A safe default beats a
  warning about an unsafe one.)

Applied identically to `@cloudflare/think` and `@cloudflare/ai-chat`.
