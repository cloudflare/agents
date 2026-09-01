---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Run root-agent chat recovery continuations as chained Tasks instead of schedule rows. Initial recovery attempts deduplicate by incident, delayed retries use durable Task sleeps, and platform failures replay through Task claims. AI Chat and Think share one reserved recovery definition and preserve their existing bounded callback handoff behavior: a failure before handoff stays with the current queue execution, while a detached post-handoff platform failure enqueues exactly one replacement.

Tasks now propagate condemned-isolate failures out of journaled steps, apply alarm memory-limit backoff and sealing to every active run of a flagged framework definition, and keep that definition policy internal. Task wake jobs defer after one dispatch attempt because the replay engine owns their durable step retry budget. `retain: false` now removes failed and cancelled runs as well as completed runs, releasing journals and idempotency keys after every terminal outcome. Routed dynamic agents temporarily retain the root-owned schedule transport until Tasks supports routed child wakes.

AI Chat and Think require `agents >=0.23.0`, the pending release batch containing the shared recovery Task definition and internal enqueue support.
