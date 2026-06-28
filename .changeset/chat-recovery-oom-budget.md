---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

Add a tight, OOM-specific retry budget to chat recovery so a memory-limit crash loop seals fast and attributably ([#1825](https://github.com/cloudflare/agents/issues/1825)).

When a recovery turn hits a Durable Object memory-limit reset (the isolate exceeded its 128 MB limit), recovery now classifies it as a distinct, deterministic failure rather than a deploy-style transient. A memory reset re-OOMs on re-run (the turn's working set, not the platform, is the cause), so it must NOT be deferred and retried forever like a code-update/connection-lost transient. Each such crash bumps a durable per-incident `oomAttempts` counter; recovery retries a small number of times (new `chatRecovery.maxOomRetries`, default `3`) — in case the OOM was a transient spike — then seals with `reason="out_of_memory"`. This is far tighter than the generic `maxRecoveryWork` backstop because an OOM is attributable and each re-run re-runs the model.

This complements the finite `maxRecoveryWork` default: the OOM budget is the fast path for memory resets that surface as catchable errors thrown from recovery bookkeeping (e.g. storage/SQL rejections after the reset), while `maxRecoveryWork` remains a backstop for the hard-kill case where no in-isolate code runs to record the OOM.

Adds an **alarm-boundary circuit breaker** (`agents`) as the universal backstop for the case the in-DO budgets can't catch (#1825): a memory-limit reset that bypasses them entirely — thrown before the budget code runs (e.g. boot-time state hydration OOMs), or whose own small writes also OOM under memory pressure. Left unhandled, such an error propagates out of `alarm()` and the platform auto-retries the alarm forever, re-running the doomed, billable turn each cycle. `Agent.alarm()` now intercepts ONLY Durable Object memory-limit resets at the outermost frame — where the heavy turn has unwound and GC has reclaimed its footprint, so the seal/purge writes can land where mid-turn ones OOMed. A durable strike counter tolerates a few resets (new `static options.maxAlarmMemoryLimitStrikes`, default `3`) — backing off the looping rows so the retry is not a hot loop — then seals the recovery (`out_of_memory`) and surgically purges only the looping schedule rows, leaving unrelated scheduled tasks intact. A new `alarm:memory_limit_reset` observability event is emitted. Everything except memory-limit resets re-throws exactly as before.

Also broadens and exports the `isDurableObjectMemoryLimitReset(error)` predicate from `agents` (a sibling to `isDurableObjectCodeUpdateReset` / `isPlatformTransientError`): it now matches the shared `"exceeded its memory limit"` fragment so truncated/reworded surfacings (observed in real #1825 logs) still classify.
