---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Run root-agent chat recovery continuations as chained Tasks instead of schedule rows. Initial recovery attempts deduplicate by incident, delayed retries use durable Task sleeps, and platform failures replay through Task claims. AI Chat and Think share one reserved recovery definition and preserve their existing bounded callback handoff behavior: a failure before handoff stays with the current queue execution, while a detached post-handoff platform failure enqueues exactly one replacement.

Tasks now propagate condemned-isolate failures out of journaled steps and apply alarm memory-limit backoff and sealing to the run whose wake struck — claim stripped and deadline pushed, so startup reconciliation cannot resurrect it and the reclaim still sees an interrupted attempt. Task wake jobs are pushed with a single dispatch attempt so a platform failure rejects the alarm instead of being retried into a silent reschedule of the still-claimed run. Lifecycle gains `trackAlarmWork()`: work a job hands off at a bounded return stays inside that alarm's memory-limit breaker domain after the alarm returns, so other jobs stay live while a memory reset from the handoff still records a strike — one strike per reset however many flows observe it — and strikes clear only once no handed-off work is outstanding and the last of it settled clean. `retain: false` now removes failed and cancelled runs as well as completed runs, releasing journals and idempotency keys after every terminal outcome. Routed dynamic agents temporarily retain the root-owned schedule transport until Tasks supports routed child wakes.

AI Chat and Think require `agents >=0.23.0`, the pending release batch containing the shared recovery Task definition and internal enqueue support.
