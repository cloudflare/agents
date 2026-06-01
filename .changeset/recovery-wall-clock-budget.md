---
"@cloudflare/think": minor
"@cloudflare/ai-chat": minor
---

Make chat recovery's budget wall-clock-keyed-to-progress instead of raw attempt
count, so a healthy turn under deploy churn isn't sealed prematurely (#1637).

Under continuous deploys the attempt count is the wrong primary bound: one
rollout drops/reconnects the socket several times (~11–22s), each firing a
recovery alarm, so the count inflated far faster than the real interruption rate
and exhausted turns that were still advancing (0/23 model calls errored in the
reported incident — it was pure eviction churn).

Now:

- **Primary bound: a 5-minute no-progress wall clock** keyed to `lastProgressAt`,
  which resets on every progress-bearing attempt. A turn that keeps producing
  content survives churn indefinitely; one that genuinely goes quiet is sealed
  within 5 minutes.
- **Alarm debounce (~30s):** recovery alarms bunched within the window (a single
  rollout's reconnect storm) collapse into one attempt.
- **Attempt cap is now a high secondary backstop** (default raised 6 → 10),
  resets on progress; it only catches a pathological tight alarm-loop.
- The existing 15-minute absolute incident-age ceiling is kept as the final
  non-resetting hard stop.
- **Progress signal moved to production time** (when new content is durably
  flushed/streamed) instead of persist time — so it advances only on genuinely
  new content and is immune to client reconnects and recovery re-persists, which
  the no-progress window depends on. (Builds on the compaction-immune counter
  from #1628.)

Applies to both `@cloudflare/think` and `@cloudflare/ai-chat`, including the
`TaskSubAgent`/sub-agent recovery path.
