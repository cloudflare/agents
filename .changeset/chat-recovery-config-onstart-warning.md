---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

warn when `chatRecovery` is configured in `onStart()` (applied too late for wake recovery)

On every Durable Object wake the SDK evaluates chat-recovery budgets — and may seal an interrupted turn, firing `onExhausted` — **before** the user's `onStart()` runs (`_checkRunFibers()` is ordered ahead of `onStart()`). A `chatRecovery` config produced inside `onStart()` is therefore read as the built-in defaults at the moment recovery decides, so a configured `maxRecoveryWork` / `shouldKeepRecovering` / `onExhausted` silently never applies to the recovery that matters.

This is now documented on `ChatRecoveryConfig` and the `chatRecovery` fields of `Think` / `AIChatAgent`, and the SDK logs a one-time warning if it detects `chatRecovery` being reassigned during `onStart()`. The warning fires both for a custom config object and for `chatRecovery = true` (enabling recovery / its defaults too late); assigning `false` (disabling) in `onStart()` is intentionally not warned, since recovery already ran with the pre-`onStart()` value and disabling it afterward is a benign no-op for that wake. The fix is to assign `chatRecovery` as a class field or in the constructor.
