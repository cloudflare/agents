---
"@cloudflare/ai-chat": minor
---

`AIChatAgent` can now detect and recover from a hung model/transport stream via
the opt-in `chatStreamStallTimeoutMs` watchdog (#1626).

Set `chatStreamStallTimeoutMs` (a class field, like `chatRecovery`) to the
maximum number of milliseconds allowed between stream chunks. If a turn parks
longer than that — a hung provider or a stalled transport — the watchdog aborts
the live stream instead of leaving the turn spinning forever. When `chatRecovery`
is enabled, the stall is routed into the same bounded-recovery machinery a
deploy/eviction interruption uses: the partial generated so far is persisted and
a continuation is scheduled (or, once the recovery budget is spent, the
configured terminal message is delivered). With `chatRecovery` disabled, a stall
surfaces as a terminal stream error so the spinner is cleared.

The default is `0`, which disables the watchdog (no behavior change unless you
opt in), matching `@cloudflare/think`. Because the watchdog measures the gap
between chunks — not total turn duration — a steadily streaming turn never trips
it regardless of overall length. Internally this is built on the shared
`iterateWithStallWatchdog` primitive both `@cloudflare/ai-chat` and
`@cloudflare/think` consume (an internal `agents/chat` seam, not a public API),
so this change ships under the `@cloudflare/ai-chat` bump alone.
