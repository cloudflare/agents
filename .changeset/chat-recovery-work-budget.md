---
"@cloudflare/ai-chat": minor
"@cloudflare/think": minor
"agents": minor
---

fix(chat-recovery): a turn making forward progress now survives unbounded deploy churn; add a work budget + `shouldKeepRecovering` runaway guard

Durable chat recovery used to bound a single incident with a non-resetting 15-minute wall-clock ceiling (`CHAT_RECOVERY_MAX_WINDOW_MS`). That ceiling was overloaded — it served as both a recovery-duration bound and a runaway-loop guard — and it terminated _healthy, actively-progressing_ turns that simply took longer than 15 minutes of wall-clock to finish while being repeatedly interrupted by a dense deploy window, sealing them with `reason="max_recovery_window_exceeded"` and discarding completed work.

The two jobs are now decoupled (see `design/rfc-chat-recovery-work-budget.md`):

- **Duration is no longer a bound for a progressing turn.** The non-resetting wall-clock ceiling is removed. A turn that keeps producing content survives unbounded deploy churn. Stuck turns are still sealed by the no-progress window (5 min, resets on progress); tight no-progress alarm loops by the attempt cap.
- **New runaway-loop guard, keyed to work, not time.** The existing durable, monotonic, reconnect-immune progress counter is reused as a work meter. `chatRecovery.maxRecoveryWork` caps the produced content/tool units since an incident opened; exceeding it seals with `reason="work_budget_exceeded"`. **Defaults to `Infinity`** — the SDK ships the mechanism but imposes no implicit cap, so it never terminates a progressing turn on its own.
- **New caller predicate.** `chatRecovery.shouldKeepRecovering(ctx)` is consulted per recovery attempt from the second onward (only when no hard bound has already sealed the incident); returning `false` seals with `reason="recovery_aborted"`. This is where integrators express token/cost/step budgets the SDK should not hardcode. A throwing predicate is logged and treated as "keep recovering".
- **The no-progress timeout is now configurable.** `chatRecovery.noProgressTimeoutMs` (default 5 min, resets on progress) is the primary stuck-turn bound, now overridable per agent instead of a hardcoded constant.

New public types from `agents/chat`: `ChatRecoveryProgressContext`. New `ChatRecoveryConfig` fields: `maxRecoveryWork`, `shouldKeepRecovering`, `noProgressTimeoutMs`. `ChatRecoveryExhaustedContext.reason` gains `work_budget_exceeded` and `recovery_aborted`; `max_recovery_window_exceeded` is retained as an open-string value but is no longer emitted.

Both `@cloudflare/ai-chat` and `@cloudflare/think` (which carries its own copy of the recovery engine) are updated identically. Defaults are unchanged except that a progressing turn is no longer terminated by wall-clock age.
