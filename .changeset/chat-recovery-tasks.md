---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Run root-agent chat recovery continuations as chained Tasks instead of schedule rows. Initial recovery attempts deduplicate by incident, delayed retries use durable Task sleeps, and platform failures replay through Task claims. AI Chat and Think share one reserved recovery definition and preserve their existing bounded callback handoff behavior.

Tasks now propagate condemned-isolate failures out of journaled steps, apply alarm memory-limit backoff and sealing to every active run of a flagged framework definition, and keep that definition policy internal. `retain: false` now removes failed and cancelled runs as well as completed runs, releasing journals and idempotency keys after every terminal outcome. Routed dynamic agents temporarily retain the root-owned schedule transport until Tasks supports routed child wakes.

AI Chat and Think now require `agents >=0.23.1`, the release containing the shared recovery Task definition and internal enqueue support.
