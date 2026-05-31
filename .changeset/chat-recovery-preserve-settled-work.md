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
- A subclass `onChatRecovery` returning `{ persist: false }` to stop a turn
  silently drops the settled partial. That behavior is unchanged (an explicit
  opt-out), but the framework now emits a one-time `console.warn` when
  `persist: false` discards a partial that contained settled tool results,
  pointing at the data-loss-free alternative `{ persist: true, continue: false }`.

Applied identically to `@cloudflare/think` and `@cloudflare/ai-chat`.
