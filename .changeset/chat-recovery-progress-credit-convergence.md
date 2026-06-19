---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Converge recovery forward-progress crediting between `AIChatAgent` and `Think`.

Both hosts now credit the recovery no-progress counter through one shared, host-agnostic rule (`shouldCreditStreamProgress`): a progress milestone (a started text/reasoning segment or a settled tool input/output) credits unconditionally, and mid-segment streaming deltas (`text-delta`/`reasoning-delta`/`tool-input-delta`) credit at most once per throttle window via a per-isolate `StreamProgressCreditThrottle`. Previously `AIChatAgent` credited only on chunk-type milestones while `Think` credited on its flush cadence, so a long single content segment spanning repeated crashes could read as "no progress" under `AIChatAgent` and false-fire its `no_progress_timeout`. The new rule is never coarser than either host's prior cadence, so it can only delay or avoid a false no-progress timeout, never hasten give-up.
