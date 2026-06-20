---
"@cloudflare/think": patch
---

`Think.waitUntilStable()` now waits out an armed-but-unfired auto-continuation
before reporting stable, converging onto `@cloudflare/ai-chat`.

Previously, when a turn ended with no pending human/client interaction,
`waitUntilStable()` reported stable immediately — even if an auto-continuation
was armed (its ~50ms coalesce timer still pending, or its completeness drain in
flight). In that window idle eviction or chat recovery could act on a transcript
that was about to be continued. `Think` now mirrors `@cloudflare/ai-chat`: while
a continuation is armed (`pending && !pastCoalesce` and the shared
`AutoContinuationController` reports armed), `waitUntilStable()` reports
not-stable and waits out the coalesce window, then re-checks (the continuation
either fires and enqueues a turn the loop drains, or parks and clears, at which
point the agent is genuinely stable).
